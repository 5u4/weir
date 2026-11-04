import { describe, expect, it } from "@effect/vitest";
import type { Occurrence, RawEvent, RawItem, StreamDescriptor } from "@weir/contract/Source";
import * as Read from "@weir/store/Read";
import type { ConversationId } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { Groups } from "../src/Groups.ts";
import { syncStream } from "../src/Sync.ts";
import type { Tags } from "../src/Tags.ts";
import { mailStream, page, rawItem, type Step, scriptedSource, storeLayer } from "./fixtures.ts";

const calendarStream: StreamDescriptor = {
  id: "calendar/primary",
  kind: "event",
  name: "Calendar",
  me: ["me@example.com"],
  openLabel: "Open in Calendar",
};

const groups: Groups = [
  { name: "Alpha", match: { type: "regex", target: "/title", regex: "^Alpha" } },
  { name: "Beta", match: { type: "regex", target: "/title", regex: "^Beta" } },
  { name: "Northwind", match: { type: "regex", target: "/title", regex: "^Northwind" } },
];
const tags: Tags = [
  { name: "offsite", match: { type: "regex", target: "/title", regex: "offsite" } },
];

const meeting = (
  eventId: string,
  updated: string,
  title: string,
  event: Partial<RawEvent> = {},
): RawItem =>
  rawItem(`${eventId}@${updated}`, {
    threadId: eventId,
    containerId: "primary",
    containerName: "Calendar",
    occurredAt: updated,
    title,
    event: {
      eventId,
      seriesId: null,
      recurring: false,
      time: {
        start: "2026-10-29T10:00:00-07:00",
        end: "2026-10-29T11:00:00-07:00",
        allDay: false,
      },
      timeZone: "America/Los_Angeles",
      location: "Room 1",
      attendees: [],
      status: "confirmed",
      originalStart: null,
      ...event,
    },
  });

const sync = (stream: StreamDescriptor, script: Map<string | null, Step>) =>
  syncStream("work", scriptedSource(script).source, stream, tags, groups, () => Effect.void);

const byTitle = Effect.gen(function* () {
  const rows = yield* Read.conversations({ _tag: "Ids", ids: yield* Read.conversationIds() });
  return Object.fromEntries(rows.map((row) => [row.title, row]));
});

const untaggedStates = Read.conversations({ _tag: "Untagged" }).pipe(
  Effect.map((rows) => rows.map(({ title, state }) => [title, state])),
);

const mailThenCalendarBackfill = Effect.gen(function* () {
  yield* sync(
    mailStream,
    new Map<string | null, Step>([
      [
        null,
        page({
          cursor: "m1",
          more: true,
          kind: "backfill",
          upserts: [rawItem("a1", { threadId: "ta", title: "Alpha launch" })],
        }),
      ],
      [
        "m1",
        page({
          cursor: "m2",
          upserts: [rawItem("b1", { threadId: "tb", title: "Beta budget" })],
        }),
      ],
    ]),
  );
  const before = yield* byTitle;
  const alpha = before.Alpha;
  if (alpha === undefined) throw new Error("no Alpha conversation");
  yield* Write.changeState([alpha.id], { _tag: "Done", seq: alpha.lastSeq });
  const untaggedBefore = yield* untaggedStates;
  yield* sync(
    calendarStream,
    new Map<string | null, Step>([
      [
        null,
        page({
          cursor: "c1",
          kind: "backfill",
          upserts: [
            meeting("alpha-review", "2026-10-10T09:00:00Z", "Alpha review"),
            meeting("beta-sync", "2026-10-11T09:00:00Z", "Beta sync"),
            meeting("standup", "2026-10-12T09:00:00Z", "Standup"),
          ],
        }),
      ],
    ]),
  );
  return { untaggedBefore };
});

describe("calendar backfill", () => {
  it.effect("is quiet: lists keep their conversations and states", () =>
    Effect.gen(function* () {
      const { untaggedBefore } = yield* mailThenCalendarBackfill;
      expect(untaggedBefore).toEqual([["Beta", "unread"]]);
      expect(yield* untaggedStates).toEqual(untaggedBefore);
      const after = yield* byTitle;
      expect(after.Alpha?.state).toBe("done");
      expect(after.Alpha?.items).toBe(2);
      expect(after.Beta?.state).toBe("unread");
      expect(after.Beta?.items).toBe(2);
      expect(after.Standup?.state).toBe("done");
    }).pipe(Effect.provide(storeLayer())),
  );
});

describe("calendar changes", () => {
  it.effect("a change is a new item that wakes a Done conversation and keeps a plan", () =>
    Effect.gen(function* () {
      yield* mailThenCalendarBackfill;
      const before = yield* byTitle;
      const beta = before.Beta;
      if (beta === undefined) throw new Error("no Beta conversation");
      yield* Write.changeState([beta.id], { _tag: "Plan", plan: { _tag: "Tray" } });
      const plannedNew = (yield* byTitle).Beta?.newItems ?? 0;
      yield* sync(
        calendarStream,
        new Map<string | null, Step>([
          [
            "c1",
            page({
              cursor: "c2",
              upserts: [
                meeting("alpha-review", "2026-10-25T16:10:00Z", "Alpha review", {
                  time: {
                    start: "2026-10-30T14:00:00-07:00",
                    end: "2026-10-30T15:00:00-07:00",
                    allDay: false,
                  },
                }),
                meeting("beta-sync", "2026-10-25T16:20:00Z", "Beta sync", {
                  location: "Room 2",
                }),
                meeting("standup", "2026-10-25T16:30:00Z", "Standup", {
                  attendees: [{ name: null, email: "new@example.com", response: null }],
                }),
              ],
            }),
          ],
        ]),
      );
      const after = yield* byTitle;
      expect(after.Alpha?.state).toBe("unread");
      expect(after.Alpha?.items).toBe(3);
      expect(after.Beta?.state).toBe("planned");
      expect(after.Beta?.newItems).toBe(plannedNew + 1);
      expect(after.Standup?.items).toBe(1);
      expect(after.Standup?.state).toBe("done");

      const changes = (id: ConversationId | undefined) =>
        Effect.gen(function* () {
          if (id === undefined) throw new Error("no conversation");
          const items = yield* Read.liveItems({ conversationIds: [id] });
          const details = yield* Read.eventDetails(items.map(({ seq }) => seq));
          return details.map(({ change }) => change);
        });
      expect(yield* changes(after.Alpha?.id)).toEqual([
        null,
        {
          _tag: "Moved",
          fromStart: "2026-10-29T10:00:00-07:00",
          fromEnd: "2026-10-29T11:00:00-07:00",
        },
      ]);
      expect(yield* changes(after.Beta?.id)).toEqual([
        null,
        { _tag: "Relocated", fromLocation: "Room 1" },
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );
});

const northwindMail = sync(
  mailStream,
  new Map<string | null, Step>([
    [
      null,
      page({
        cursor: "m1",
        upserts: [
          rawItem("n1", { threadId: "tn", title: "Northwind renewal" }),
          rawItem("n2", { threadId: "tn", title: "Northwind renewal" }),
        ],
      }),
    ],
  ]),
);

const planningInvite = sync(
  calendarStream,
  new Map<string | null, Step>([
    [
      null,
      page({ cursor: "p1", upserts: [meeting("planning", "2026-10-10T09:00:00Z", "Planning")] }),
    ],
  ]),
);

const renamePlanning = (from: string, updated: string, title: string) =>
  sync(
    calendarStream,
    new Map<string | null, Step>([
      [from, page({ cursor: `${from}+`, upserts: [meeting("planning", updated, title)] })],
    ]),
  );

const northwind = Effect.gen(function* () {
  const row = (yield* byTitle).Northwind;
  if (row === undefined) throw new Error("no Northwind conversation");
  return row;
});

const tagsOf = (id: ConversationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ tag: string }>`SELECT tag FROM conversation_tag
      WHERE conversation_id = ${id} ORDER BY tag`;
    return rows.map(({ tag }) => tag);
  });

describe("calendar edits", () => {
  it.effect("a rename into a Done group moves the meeting and keeps the group Done", () =>
    Effect.gen(function* () {
      yield* northwindMail;
      const before = yield* northwind;
      yield* Write.changeState([before.id], { _tag: "Done", seq: before.lastSeq });
      yield* planningInvite;
      yield* renamePlanning("p1", "2026-10-20T09:00:00Z", "Northwind planning");
      const after = yield* northwind;
      expect(after.lastSeq).toBeGreaterThan(before.lastSeq);
      expect([after.items, after.state]).toEqual([3, "done"]);
      expect((yield* byTitle).Planning).toBeUndefined();
      expect(yield* untaggedStates).toEqual([]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a rename into a read group moves the meeting and keeps the group read", () =>
    Effect.gen(function* () {
      yield* northwindMail;
      const before = yield* northwind;
      yield* Write.changeState([before.id], { _tag: "Read", seq: before.lastSeq });
      yield* planningInvite;
      yield* renamePlanning("p1", "2026-10-20T09:00:00Z", "Northwind planning");
      const after = yield* northwind;
      expect(after.lastSeq).toBeGreaterThan(before.lastSeq);
      expect([after.items, after.state, after.newItems]).toEqual([3, "read", 0]);
      expect(yield* untaggedStates).toEqual([["Northwind", "read"]]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a rename into an unread group keeps its unread state and new count", () =>
    Effect.gen(function* () {
      yield* planningInvite;
      yield* northwindMail;
      const before = yield* northwind;
      expect([before.state, before.newItems]).toEqual(["unread", 2]);
      yield* renamePlanning("p1", "2026-10-20T09:00:00Z", "Northwind planning");
      const after = yield* northwind;
      expect([after.items, after.state, after.newItems]).toEqual([3, "unread", 2]);
      expect((yield* byTitle).Planning).toBeUndefined();
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a title edit adds and drops a matching tag", () =>
    Effect.gen(function* () {
      yield* planningInvite;
      const planning = (yield* byTitle).Planning;
      if (planning === undefined) throw new Error("no Planning conversation");
      expect(yield* tagsOf(planning.id)).toEqual([]);
      yield* renamePlanning("p1", "2026-10-20T09:00:00Z", "Planning offsite");
      expect(yield* tagsOf(planning.id)).toEqual(["offsite"]);
      yield* renamePlanning("p1+", "2026-10-21T09:00:00Z", "Planning");
      expect(yield* tagsOf(planning.id)).toEqual([]);
    }).pipe(Effect.provide(storeLayer())),
  );
});

const SERIES = "one";
const dates = ["2026-10-26", "2026-10-27", "2026-10-28"];
const slot = (date: string): Occurrence => ({
  eventId: `${SERIES}_${date}`,
  start: `${date}T09:30:00-07:00`,
  end: `${date}T10:00:00-07:00`,
  allDay: false,
  status: "confirmed",
});
const inSeries = (item: RawItem): RawItem => ({ ...item, threadId: SERIES });
const sparseCancel = (eventId: string, originalStart: string | null): RawItem => ({
  ...inSeries(
    meeting(eventId, "2026-10-21T09:00:00Z", "", {
      seriesId: originalStart === null ? null : SERIES,
      time: null,
      timeZone: null,
      location: null,
      status: "cancelled",
      originalStart,
    }),
  ),
  title: null,
});
const seriesMaster = (updated: string, title: string, event: Partial<RawEvent> = {}) =>
  meeting(SERIES, updated, title, {
    seriesId: SERIES,
    recurring: true,
    time: { start: "2026-10-26T09:30:00-07:00", end: "2026-10-26T10:00:00-07:00", allDay: false },
    location: "Lisa's office",
    attendees: [{ name: "Lisa", email: "lisa@example.com", response: "accepted" }],
    ...event,
  });

const seriesBackfill = sync(
  calendarStream,
  new Map<string | null, Step>([
    [
      null,
      page({
        cursor: "s1",
        kind: "backfill",
        upserts: [seriesMaster("2026-10-01T09:00:00Z", "Weekday 1:1")],
        occurrences: [{ seriesId: SERIES, occurrences: dates.map(slot) }],
      }),
    ],
  ]),
);

const liveStep = (upserts: ReadonlyArray<RawItem>, occurrences?: ReadonlyArray<Occurrence>) =>
  sync(
    calendarStream,
    new Map<string | null, Step>([
      [
        "s1",
        page({
          cursor: "s2",
          upserts: [...upserts],
          ...(occurrences === undefined
            ? {}
            : { occurrences: [{ seriesId: SERIES, occurrences }] }),
        }),
      ],
    ]),
  );

const seriesMeetings = Read.meetings(
  DateTime.makeUnsafe("2026-10-25T00:00:00Z"),
  DateTime.makeUnsafe("2026-11-08T00:00:00Z"),
).pipe(Effect.map((rows) => rows.filter(({ seriesId }) => seriesId === SERIES)));

const seriesConversation = Effect.gen(function* () {
  const row = (yield* byTitle)["Weekday 1:1"];
  if (row === undefined) throw new Error("no series conversation");
  return row;
});

const detailsOf = (id: ConversationId) =>
  Effect.gen(function* () {
    const items = yield* Read.liveItems({ conversationIds: [id] });
    return yield* Read.eventDetails(items.map(({ seq }) => seq));
  });

describe("recurring series", () => {
  it.effect("a sparse cancelled occurrence is a Cancelled item that wakes a Done series", () =>
    Effect.gen(function* () {
      yield* seriesBackfill;
      const before = yield* seriesConversation;
      expect(before.state).toBe("done");
      yield* liveStep(
        [
          sparseCancel(`${SERIES}_2026-10-27`, "2026-10-27T09:30:00-07:00"),
          sparseCancel(`${SERIES}_2026-11-04`, "2026-11-04T09:30:00-07:00"),
        ],
        [slot("2026-10-26"), slot("2026-10-28")],
      );
      const after = yield* seriesConversation;
      expect(after.state).toBe("unread");
      expect(after.items).toBe(3);
      const cancelled = (yield* detailsOf(after.id)).filter(({ status }) => status === "cancelled");
      expect(
        cancelled.map(({ eventId, seriesId, startAt, endAt, location, change }) => [
          eventId,
          seriesId,
          startAt,
          endAt,
          location,
          change,
        ]),
      ).toEqual([
        [
          `${SERIES}_2026-10-27`,
          SERIES,
          "2026-10-27T09:30:00-07:00",
          "2026-10-27T10:00:00-07:00",
          "Lisa's office",
          { _tag: "Cancelled" },
        ],
        [
          `${SERIES}_2026-11-04`,
          SERIES,
          "2026-11-04T09:30:00-07:00",
          "2026-11-04T10:00:00-07:00",
          "Lisa's office",
          { _tag: "Cancelled" },
        ],
      ]);
      expect((yield* seriesMeetings).map(({ startAt }) => startAt)).toEqual([
        "2026-10-26T09:30:00-07:00",
        "2026-10-28T09:30:00-07:00",
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a sparse cancelled occurrence keeps a planned series planned with one new item", () =>
    Effect.gen(function* () {
      yield* seriesBackfill;
      const before = yield* seriesConversation;
      yield* Write.changeState([before.id], { _tag: "Plan", plan: { _tag: "Tray" } });
      const plannedNew = (yield* seriesConversation).newItems;
      yield* liveStep([sparseCancel(`${SERIES}_2026-10-27`, "2026-10-27T09:30:00-07:00")]);
      const after = yield* seriesConversation;
      expect(after.state).toBe("planned");
      expect(after.newItems).toBe(plannedNew + 1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a title, description and attendee edit updates the card without a new item", () =>
    Effect.gen(function* () {
      yield* seriesBackfill;
      const before = yield* seriesConversation;
      const listBefore = yield* untaggedStates;
      const [itemBefore] = yield* Read.liveItems({ conversationIds: [before.id] });
      const attendees = [
        { name: "Lisa", email: "lisa@example.com", response: "accepted" },
        { name: "Omar", email: "omar@example.com", response: "needsAction" },
      ];
      yield* liveStep([
        {
          ...seriesMaster("2026-10-20T09:00:00Z", "Weekday 1:1 with Omar", { attendees }),
          body: "Agenda v2",
        },
      ]);
      const after = Option.getOrThrow(yield* Read.conversation(before.id));
      expect([after.lastSeq, after.seenSeq, after.clearedSeq, after.state, after.items]).toEqual([
        before.lastSeq,
        before.seenSeq,
        before.clearedSeq,
        before.state,
        before.items,
      ]);
      expect(yield* untaggedStates).toEqual(listBefore);
      const items = yield* Read.liveItems({ conversationIds: [before.id] });
      expect(items.map(({ seq, title, text }) => [seq, title, text])).toEqual([
        [itemBefore?.seq, "Weekday 1:1 with Omar", "Agenda v2"],
      ]);
      const [detail] = yield* detailsOf(before.id);
      expect(detail?.attendees).toEqual(attendees);
      expect(detail?.change).toBeNull();
      expect((yield* seriesMeetings).map(({ title }) => title)).toEqual([
        "Weekday 1:1 with Omar",
        "Weekday 1:1 with Omar",
        "Weekday 1:1 with Omar",
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a sparse cancelled master stays in its series and drops every occurrence", () =>
    Effect.gen(function* () {
      yield* seriesBackfill;
      expect(yield* seriesMeetings).toHaveLength(3);
      yield* liveStep([sparseCancel(SERIES, null)]);
      const after = yield* seriesConversation;
      const details = yield* detailsOf(after.id);
      expect(
        details.map(({ seriesId, recurring, status }) => [seriesId, recurring, status]),
      ).toEqual([
        [SERIES, true, "confirmed"],
        [SERIES, true, "cancelled"],
      ]);
      expect(yield* seriesMeetings).toEqual([]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a moved occurrence shows at its new time and opens the exception item", () =>
    Effect.gen(function* () {
      yield* seriesBackfill;
      const [master] = yield* Read.liveItems({
        conversationIds: [(yield* seriesConversation).id],
      });
      const movedTime = {
        start: "2026-10-28T11:00:00-07:00",
        end: "2026-10-28T11:30:00-07:00",
        allDay: false,
      };
      yield* liveStep(
        [
          inSeries(
            meeting(`${SERIES}_2026-10-28`, "2026-10-20T10:00:00Z", "Weekday 1:1 (moved)", {
              seriesId: SERIES,
              time: movedTime,
              location: "Lisa's office",
              originalStart: "2026-10-28T09:30:00-07:00",
            }),
          ),
        ],
        [slot("2026-10-26"), slot("2026-10-27"), { ...slot("2026-10-28"), ...movedTime }],
      );
      const items = yield* Read.liveItems({
        conversationIds: [(yield* seriesConversation).id],
      });
      const exception = items.find(({ seq }) => seq !== master?.seq);
      const rows = yield* seriesMeetings;
      expect(
        rows.map(({ startAt, title, itemSeq, change }) => [startAt, title, itemSeq, change]),
      ).toEqual([
        ["2026-10-26T09:30:00-07:00", "Weekday 1:1", master?.seq, null],
        ["2026-10-27T09:30:00-07:00", "Weekday 1:1", master?.seq, null],
        [
          "2026-10-28T11:00:00-07:00",
          "Weekday 1:1 (moved)",
          exception?.seq,
          {
            _tag: "Moved",
            fromStart: "2026-10-28T09:30:00-07:00",
            fromEnd: "2026-10-28T10:00:00-07:00",
          },
        ],
      ]);
      expect(rows.some(({ startAt }) => startAt === "2026-10-28T09:30:00-07:00")).toBe(false);
    }).pipe(Effect.provide(storeLayer())),
  );
});
