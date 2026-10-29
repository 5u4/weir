import { describe, expect, it } from "@effect/vitest";
import type { Rule } from "@weir/contract/Rule";
import type { Source } from "@weir/contract/Source";
import { conversations, search } from "@weir/store/Read";
import { ConversationId } from "@weir/store/Rows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { syncSource, syncStream } from "../src/Sync.ts";
import { recomputeAllTags, type Tags } from "../src/Tags.ts";
import { mailStream, page, rawItem, type Step, scriptedSource, storeLayer } from "./fixtures.ts";

const github: Rule = { type: "regex", target: "/from/address", regex: "@github\\.com$" };
const urgent: Rule = {
  type: "some",
  target: "/raw/labelIds",
  rule: { type: "eq", target: "", is: "URGENT" },
};
const tags: Tags = [
  { name: "github", match: github },
  { name: "urgent", match: urgent },
];

const fromGithub = { name: "GitHub", address: "Notifications@GitHub.com" };

const ignoreWritten = () => Effect.void;

const run = (script: Map<string | null, Step>, runTags: Tags = tags) =>
  syncStream("mail", scriptedSource(script).source, mailStream, runTags, ignoreWritten);

const streamState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [stream] = yield* sql<{
    cursor: string | null;
    backfilledAt: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  }>`SELECT cursor, backfilled_at, last_sync_at, last_error FROM stream`;
  return stream;
});

const items = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    externalId: string;
    seq: number;
    deletedAt: string | null;
  }>`SELECT external_id, seq, deleted_at FROM item ORDER BY seq`;
});

const seenByThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string; seenSeq: number }>`SELECT conversation.key, seen_seq
    FROM conversation_state JOIN conversation ON conversation.id = conversation_state.conversation_id
    ORDER BY conversation.key`;
  return Object.fromEntries(rows.map(({ key, seenSeq }) => [key, seenSeq]));
});

const tagsByThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    key: string;
    tag: string;
  }>`SELECT conversation.key, conversation_tag.tag
    FROM conversation_tag JOIN conversation ON conversation.id = conversation_tag.conversation_id
    ORDER BY conversation.key, conversation_tag.tag`;
  return rows.map(({ key, tag }) => `${key}:${tag}`);
});

const syncRuns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    startedAt: string;
    ms: number;
    upserts: number;
    deletions: number;
    error: string | null;
  }>`SELECT started_at, ms, upserts, deletions, error FROM sync_run ORDER BY id`;
});

describe("syncStream paging", () => {
  it.effect("commits each page on its own and resumes from the stored cursor after a failure", () =>
    Effect.gen(function* () {
      const script = new Map<string | null, Step>([
        [null, page({ cursor: "c1", more: true, upserts: [rawItem("m1")] })],
        ["c1", new Error("page 2 exploded")],
      ]);
      const failed = scriptedSource(script);
      const error = yield* Effect.flip(
        syncStream("mail", failed.source, mailStream, tags, ignoreWritten),
      );
      expect(error._tag).toBe("SourceError");
      expect((yield* items).map(({ externalId }) => externalId)).toEqual(["m1"]);
      expect((yield* streamState)?.cursor).toBe("c1");

      script.set("c1", page({ cursor: "c2", upserts: [rawItem("m2")] }));
      const resumed = scriptedSource(script);
      yield* syncStream("mail", resumed.source, mailStream, tags, ignoreWritten);
      expect(failed.calls).toEqual([null, "c1"]);
      expect(resumed.calls).toEqual(["c1"]);
      expect((yield* items).map(({ externalId }) => externalId)).toEqual(["m1", "m2"]);
      expect((yield* streamState)?.cursor).toBe("c2");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("reports the conversations each committed page wrote, deletions included", () =>
    Effect.gen(function* () {
      const reported: Array<ReadonlyArray<number>> = [];
      const { source } = scriptedSource(
        new Map<string | null, Step>([
          [
            null,
            page({
              cursor: "c1",
              more: true,
              upserts: [rawItem("m1", { threadId: "t1" }), rawItem("m2", { threadId: "t2" })],
            }),
          ],
          ["c1", page({ cursor: "c2", more: true, deletions: ["m1"] })],
          ["c2", new Error("page 3 exploded")],
        ]),
      );
      yield* Effect.flip(
        syncStream("mail", source, mailStream, tags, (ids) =>
          Effect.sync(() => reported.push(ids)),
        ),
      );
      const sql = yield* SqlClient.SqlClient;
      const keys = new Map(
        (yield* sql<{ id: number; key: string }>`SELECT id, key FROM conversation`).map(
          ({ id, key }) => [id, key],
        ),
      );
      expect(reported.map((ids) => ids.map((id) => keys.get(id)).toSorted())).toEqual([
        ["t1", "t2"],
        ["t1"],
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("rolls back a page whose write fails, keeping the previous cursor", () =>
    Effect.gen(function* () {
      const script = new Map<string | null, Step>([
        [null, page({ cursor: "c1", more: true, upserts: [rawItem("m1")] })],
        ["c1", page({ cursor: "c2", upserts: [rawItem("m2"), rawItem("m3")] })],
      ]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_m3 BEFORE INSERT ON item WHEN NEW.external_id = 'm3'
        BEGIN SELECT RAISE(ABORT, 'm3 rejected'); END`;
      yield* Effect.flip(run(script));
      expect((yield* items).map(({ externalId }) => externalId)).toEqual(["m1"]);
      expect((yield* streamState)?.cursor).toBe("c1");
    }).pipe(Effect.provide(storeLayer())),
  );
});

const stateByThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ids = (yield* sql<{ id: number }>`SELECT id FROM conversation`).map(({ id }) =>
    ConversationId.make(id),
  );
  const rows = yield* conversations({ _tag: "Ids", ids });
  return Object.fromEntries(rows.map(({ key, state }) => [key, state]));
});

const at = (iso: string) => TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

const backfill = (overrides: Parameters<typeof page>[0]) =>
  page({ kind: "backfill", backfill: "running", ...overrides });

describe("syncStream read state per page", () => {
  it.effect("backfill pages leave new conversations read; backfilled_at waits for done", () =>
    Effect.gen(function* () {
      const script = new Map<string | null, Step>([
        [
          null,
          backfill({ cursor: "c1", more: true, upserts: [rawItem("a1", { threadId: "t1" })] }),
        ],
        ["c1", new Error("offline")],
      ]);
      yield* Effect.flip(run(script));
      expect(yield* stateByThread).toEqual({ t1: "read" });
      expect((yield* streamState)?.backfilledAt).toBeNull();

      yield* at("2026-10-28T12:00:00Z");
      script.set(
        "c1",
        backfill({
          cursor: "c2",
          backfill: "done",
          upserts: [rawItem("a2", { threadId: "t1" }), rawItem("b1", { threadId: "t2" })],
        }),
      );
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "read", t2: "read" });
      expect((yield* streamState)?.backfilledAt).toBe("2026-10-28T12:00:00.000Z");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a live page after the backfill delivers unread and keeps backfilled_at", () =>
    Effect.gen(function* () {
      yield* at("2026-10-28T12:00:00Z");
      const script = new Map<string | null, Step>([
        [
          null,
          backfill({
            cursor: "c1",
            backfill: "done",
            upserts: [rawItem("a1", { threadId: "t1" })],
          }),
        ],
      ]);
      yield* run(script);

      yield* at("2026-10-29T08:00:00Z");
      script.set(
        "c1",
        page({
          cursor: "c2",
          upserts: [rawItem("a2", { threadId: "t1" }), rawItem("n1", { threadId: "t9" })],
        }),
      );
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "unread", t9: "unread" });
      expect((yield* streamState)?.backfilledAt).toBe("2026-10-28T12:00:00.000Z");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a backfill page re-listing an unread live item leaves it unread", () =>
    Effect.gen(function* () {
      const script = new Map<string | null, Step>([
        [
          null,
          backfill({
            cursor: "c1",
            backfill: "done",
            upserts: [rawItem("a1", { threadId: "t1" })],
          }),
        ],
        ["c1", page({ cursor: "c2", upserts: [rawItem("a2", { threadId: "t1" })] })],
        [
          "c2",
          backfill({
            cursor: "c3",
            upserts: [rawItem("a2", { threadId: "t1" }), rawItem("b1", { threadId: "t2" })],
          }),
        ],
      ]);
      yield* run(script);
      yield* run(script);
      const seenBefore = yield* seenByThread;
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "unread", t2: "read" });
      expect((yield* seenByThread).t1).toBe(seenBefore.t1);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a backfill page adding an older message keeps each conversation's read state", () =>
    Effect.gen(function* () {
      const older = { occurredAt: "2026-10-01T09:00:00Z" };
      const script = new Map<string | null, Step>([
        [
          null,
          backfill({
            cursor: "c1",
            backfill: "done",
            upserts: [rawItem("a1", { threadId: "t1" }), rawItem("b1", { threadId: "t2" })],
          }),
        ],
        ["c1", page({ cursor: "c2", upserts: [rawItem("a2", { threadId: "t1" })] })],
        [
          "c2",
          backfill({
            cursor: "c3",
            upserts: [
              rawItem("a0", { threadId: "t1", ...older }),
              rawItem("b0", { threadId: "t2", ...older }),
            ],
          }),
        ],
      ]);
      yield* run(script);
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "unread", t2: "read" });
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "unread", t2: "read" });
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a live page between backfill pages delivers unread while the backfill runs", () =>
    Effect.gen(function* () {
      const script = new Map<string | null, Step>([
        [null, backfill({ cursor: "c1", upserts: [rawItem("a1", { threadId: "t1" })] })],
        [
          "c1",
          page({ cursor: "c2", backfill: "running", upserts: [rawItem("n1", { threadId: "t9" })] }),
        ],
        [
          "c2",
          backfill({
            cursor: "c3",
            backfill: "done",
            upserts: [rawItem("b1", { threadId: "t2" })],
          }),
        ],
      ]);
      yield* run(script);
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "read", t9: "unread" });
      expect((yield* streamState)?.backfilledAt).toBeNull();

      yield* at("2026-10-28T12:00:00Z");
      yield* run(script);
      expect(yield* stateByThread).toEqual({ t1: "read", t2: "read", t9: "unread" });
      expect((yield* streamState)?.backfilledAt).toBe("2026-10-28T12:00:00.000Z");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a running page after done clears backfilled_at until the next done", () =>
    Effect.gen(function* () {
      yield* at("2026-10-28T12:00:00Z");
      const script = new Map<string | null, Step>([
        [null, backfill({ cursor: "c1", backfill: "done", upserts: [rawItem("a1")] })],
        ["c1", backfill({ cursor: "c2", upserts: [rawItem("a1")] })],
        ["c2", backfill({ cursor: "c3", backfill: "done", upserts: [rawItem("a2")] })],
      ]);
      yield* run(script);
      expect((yield* streamState)?.backfilledAt).toBe("2026-10-28T12:00:00.000Z");

      yield* at("2026-10-29T08:00:00Z");
      yield* run(script);
      expect((yield* streamState)?.backfilledAt).toBeNull();

      yield* at("2026-10-29T09:00:00Z");
      yield* run(script);
      expect((yield* streamState)?.backfilledAt).toBe("2026-10-29T09:00:00.000Z");
    }).pipe(Effect.provide(storeLayer())),
  );
});

describe("syncStream tags", () => {
  it.effect("a new item adds its matching tags to the conversation", () =>
    Effect.gen(function* () {
      yield* run(
        new Map([
          [
            null,
            page({
              cursor: "c1",
              upserts: [
                rawItem("a1", { threadId: "t1", from: fromGithub }),
                rawItem("b1", { threadId: "t2" }),
              ],
            }),
          ],
        ]),
      );
      expect(yield* tagsByThread).toEqual(["t1:github"]);

      yield* run(
        new Map([["c1", page({ cursor: "c2", upserts: [rawItem("a2", { threadId: "t1" })] })]]),
      );
      expect(yield* tagsByThread).toEqual(["t1:github"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a change to the stream's me retags conversations even on an empty page", () =>
    Effect.gen(function* () {
      const fromMeTags: Tags = [
        { name: "sent", match: { type: "eq", target: "/fromMe", is: true } },
      ];
      const { source } = scriptedSource(
        new Map([
          [null, page({ cursor: "c1", upserts: [rawItem("a1", { threadId: "t1" })] })],
          ["c1", page({ cursor: "c1" })],
        ]),
      );
      yield* syncStream("mail", source, mailStream, fromMeTags, ignoreWritten);
      expect(yield* tagsByThread).toEqual([]);

      const aliased = { ...mailStream, me: [...mailStream.me, "ADA@example.com"] };
      yield* syncStream("mail", source, aliased, fromMeTags, ignoreWritten);
      expect(yield* tagsByThread).toEqual(["t1:sent"]);

      yield* syncStream("mail", source, mailStream, fromMeTags, ignoreWritten);
      expect(yield* tagsByThread).toEqual([]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("re-upserting an item recomputes its conversation and can remove a tag", () =>
    Effect.gen(function* () {
      yield* run(
        new Map([
          [
            null,
            page({
              cursor: "c1",
              upserts: [
                rawItem("a1", { threadId: "t1", from: fromGithub, raw: { labelIds: ["URGENT"] } }),
              ],
            }),
          ],
        ]),
      );
      expect(yield* tagsByThread).toEqual(["t1:github", "t1:urgent"]);

      yield* run(
        new Map([
          [
            "c1",
            page({
              cursor: "c2",
              upserts: [rawItem("a1", { threadId: "t1", from: fromGithub, raw: { labelIds: [] } })],
            }),
          ],
        ]),
      );
      expect(yield* tagsByThread).toEqual(["t1:github"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("an item that moves to another conversation takes its tags with it", () =>
    Effect.gen(function* () {
      yield* run(
        new Map([
          [
            null,
            page({ cursor: "c1", upserts: [rawItem("a1", { threadId: "t1", from: fromGithub })] }),
          ],
        ]),
      );
      yield* run(
        new Map([
          [
            "c1",
            page({ cursor: "c2", upserts: [rawItem("a1", { threadId: "t2", from: fromGithub })] }),
          ],
        ]),
      );
      expect(yield* tagsByThread).toEqual(["t2:github"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a deletion soft-deletes the item and recomputes its conversation", () =>
    Effect.gen(function* () {
      yield* run(
        new Map([
          [
            null,
            page({
              cursor: "c1",
              upserts: [
                rawItem("a1", { threadId: "t1", from: fromGithub }),
                rawItem("a2", { threadId: "t1", raw: { labelIds: ["URGENT"] } }),
              ],
            }),
          ],
        ]),
      );
      expect(yield* tagsByThread).toEqual(["t1:github", "t1:urgent"]);

      yield* run(new Map([["c1", page({ cursor: "c2", deletions: ["a1"] })]]));
      expect(yield* tagsByThread).toEqual(["t1:urgent"]);
      const deleted = (yield* items).find(({ externalId }) => externalId === "a1");
      expect(deleted?.deletedAt).not.toBeNull();
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("recomputeAllTags rebuilds every conversation from the given rules", () =>
    Effect.gen(function* () {
      yield* run(
        new Map([
          [
            null,
            page({
              cursor: "c1",
              upserts: [
                rawItem("a1", { threadId: "t1", from: fromGithub }),
                rawItem("b1", { threadId: "t2", raw: { labelIds: ["URGENT"] } }),
              ],
            }),
          ],
        ]),
      );
      expect(yield* tagsByThread).toEqual(["t1:github", "t2:urgent"]);

      yield* recomputeAllTags([
        { name: "urgent", match: urgent },
        { name: "everything", match: { type: "exists", target: "/source" } },
      ]);
      expect(yield* tagsByThread).toEqual(["t1:everything", "t2:everything", "t2:urgent"]);
    }).pipe(Effect.provide(storeLayer())),
  );
});

describe("syncStream sync_run", () => {
  it.effect("records one row per run, including a failing run, and updates the stream", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:30:00Z")));
      const script = new Map<string | null, Step>([
        [null, page({ cursor: "c1", more: true, upserts: [rawItem("a1"), rawItem("a2")] })],
        ["c1", page({ cursor: "c2", upserts: [rawItem("a3")], deletions: ["a1"] })],
      ]);
      yield* run(script);
      expect(yield* syncRuns).toEqual([
        { startedAt: "2026-10-28T09:30:00.000Z", ms: 0, upserts: 3, deletions: 1, error: null },
      ]);
      expect(yield* streamState).toMatchObject({
        lastSyncAt: "2026-10-28T09:30:00.000Z",
        lastError: null,
      });

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:35:00Z")));
      script.set("c2", new Error("token expired"));
      yield* Effect.flip(run(script));
      expect((yield* syncRuns).slice(1)).toEqual([
        {
          startedAt: "2026-10-28T09:35:00.000Z",
          ms: 0,
          upserts: 0,
          deletions: 0,
          error: "token expired",
        },
      ]);
      expect(yield* streamState).toMatchObject({
        lastSyncAt: "2026-10-28T09:35:00.000Z",
        lastError: "token expired",
      });
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("records a page the plugin returns in the wrong shape as a failed run", () =>
    Effect.gen(function* () {
      const malformed = { ...page({ cursor: "c1" }), extra: true };
      yield* Effect.flip(run(new Map([[null, malformed]])));
      const [syncRun] = yield* syncRuns;
      expect(syncRun?.error).toContain("extra");
      expect((yield* streamState)?.cursor).toBeNull();
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("records a failed run when retagging after a change to me fails", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:30:00Z")));
      const fromMeTags: Tags = [
        { name: "sent", match: { type: "eq", target: "/fromMe", is: true } },
      ];
      const { source } = scriptedSource(
        new Map([
          [null, page({ cursor: "c1", upserts: [rawItem("a1", { threadId: "t1" })] })],
          ["c1", page({ cursor: "c1" })],
        ]),
      );
      yield* syncStream("mail", source, mailStream, fromMeTags, ignoreWritten);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE item SET raw = 'not json'`;

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:35:00Z")));
      const aliased = { ...mailStream, me: [...mailStream.me, "ada@example.com"] };
      yield* Effect.flip(syncStream("mail", source, aliased, fromMeTags, ignoreWritten));

      const runs = yield* syncRuns;
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ startedAt: "2026-10-28T09:35:00.000Z", upserts: 0 });
      expect(runs[1]?.error).toEqual(expect.any(String));
      expect(yield* streamState).toMatchObject({
        lastSyncAt: "2026-10-28T09:35:00.000Z",
        lastError: runs[1]?.error,
      });
    }).pipe(Effect.provide(storeLayer())),
  );
});

describe("syncStream bodyNew", () => {
  it.effect("strips quoted history when the plugin leaves bodyNew null, so search skips it", () =>
    Effect.gen(function* () {
      yield* run(
        new Map([
          [
            null,
            page({
              cursor: "c1",
              upserts: [
                rawItem("a1", {
                  bodyNew: null,
                  body: [
                    "Sounds good, ship it.",
                    "",
                    "On Tue, Oct 27, 2026 at 9:00 AM Ada <ada@example.com> wrote:",
                    "> the zanzibar rollout plan",
                  ].join("\n"),
                }),
              ],
            }),
          ],
        ]),
      );
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql<{ bodyNew: string }>`SELECT body_new FROM item`).toEqual([
        { bodyNew: "Sounds good, ship it." },
      ]);
      expect(yield* search({ query: "zanzibar" })).toEqual([]);
      expect(yield* search({ query: "ship it" })).toHaveLength(1);
    }).pipe(Effect.provide(storeLayer())),
  );
});

describe("syncSource failures", () => {
  const failingStreams = (failure: () => Promise<unknown>): Source => ({
    streams: failure as Source["streams"],
    sync: async () => page({ cursor: "c1" }),
  });

  it.effect("records a failed run on each known stream when streams() throws", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:30:00Z")));
      yield* syncSource(
        "mail",
        scriptedSource(new Map([[null, page({ cursor: "c1" })]])).source,
        tags,
        ignoreWritten,
      );

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:35:00Z")));
      const error = yield* Effect.flip(
        syncSource(
          "mail",
          failingStreams(() => Promise.reject(new Error("token revoked"))),
          tags,
          ignoreWritten,
        ),
      );
      expect(error.message).toContain("token revoked");
      expect((yield* syncRuns).slice(1)).toEqual([
        {
          startedAt: "2026-10-28T09:35:00.000Z",
          ms: 0,
          upserts: 0,
          deletions: 0,
          error: "token revoked",
        },
      ]);
      expect(yield* streamState).toMatchObject({
        lastSyncAt: "2026-10-28T09:35:00.000Z",
        lastError: "token revoked",
      });
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("records descriptors in the wrong shape as a failed run", () =>
    Effect.gen(function* () {
      yield* syncSource(
        "mail",
        scriptedSource(new Map([[null, page({ cursor: "c1" })]])).source,
        tags,
        ignoreWritten,
      );
      yield* Effect.flip(
        syncSource(
          "mail",
          failingStreams(async () => [{ ...mailStream, extra: true }]),
          tags,
          ignoreWritten,
        ),
      );
      expect((yield* streamState)?.lastError).toContain("extra");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("leaves other sources' streams alone", () =>
    Effect.gen(function* () {
      yield* syncSource(
        "other",
        scriptedSource(new Map([[null, page({ cursor: "c1" })]])).source,
        tags,
        ignoreWritten,
      );
      yield* Effect.flip(
        syncSource(
          "mail",
          failingStreams(() => Promise.reject(new Error("down"))),
          tags,
          ignoreWritten,
        ),
      );
      expect(yield* syncRuns).toHaveLength(1);
      expect((yield* streamState)?.lastError).toBeNull();
    }).pipe(Effect.provide(storeLayer())),
  );
});
