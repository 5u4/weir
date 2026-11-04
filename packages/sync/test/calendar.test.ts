import { describe, expect, it } from "@effect/vitest";
import type { RawEvent, RawItem, StreamDescriptor } from "@weir/contract/Source";
import * as Read from "@weir/store/Read";
import type { ConversationId } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Effect from "effect/Effect";
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
];
const tags: Tags = [];

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
