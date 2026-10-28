import { describe, expect, it } from "@effect/vitest";
import type { Rule } from "@weir/contract/Rule";
import type { Source } from "@weir/contract/Source";
import { search } from "@weir/store/Read";
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

const run = (script: Map<string | null, Step>, runTags: Tags = tags) =>
  syncStream("mail", scriptedSource(script).source, mailStream, runTags);

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

const seqOf = (externalId: string) =>
  items.pipe(Effect.map((rows) => rows.find((row) => row.externalId === externalId)?.seq ?? -1));

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
      const error = yield* Effect.flip(syncStream("mail", failed.source, mailStream, tags));
      expect(error._tag).toBe("SourceError");
      expect((yield* items).map(({ externalId }) => externalId)).toEqual(["m1"]);
      expect((yield* streamState)?.cursor).toBe("c1");

      script.set("c1", page({ cursor: "c2", upserts: [rawItem("m2")] }));
      const resumed = scriptedSource(script);
      yield* syncStream("mail", resumed.source, mailStream, tags);
      expect(failed.calls).toEqual([null, "c1"]);
      expect(resumed.calls).toEqual(["c1"]);
      expect((yield* items).map(({ externalId }) => externalId)).toEqual(["m1", "m2"]);
      expect((yield* streamState)?.cursor).toBe("c2");
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

describe("syncStream cold start", () => {
  it.effect(
    "marks backfilled conversations seen and writes backfilled_at only on the last page",
    () =>
      Effect.gen(function* () {
        const script = new Map<string | null, Step>([
          [null, page({ cursor: "c1", more: true, upserts: [rawItem("a1", { threadId: "t1" })] })],
          ["c1", new Error("offline")],
        ]);
        yield* Effect.flip(run(script));
        expect(yield* seenByThread).toEqual({ t1: yield* seqOf("a1") });
        expect((yield* streamState)?.backfilledAt).toBeNull();

        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T12:00:00Z")),
        );
        script.set(
          "c1",
          page({
            cursor: "c2",
            upserts: [rawItem("a2", { threadId: "t1" }), rawItem("b1", { threadId: "t2" })],
          }),
        );
        yield* run(script);
        expect(yield* seenByThread).toEqual({ t1: yield* seqOf("a2"), t2: yield* seqOf("b1") });
        expect((yield* streamState)?.backfilledAt).toBe("2026-10-28T12:00:00.000Z");

        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-29T08:00:00Z")),
        );
        script.set("c2", page({ cursor: "c3", upserts: [rawItem("a3", { threadId: "t1" })] }));
        yield* run(script);
        expect(yield* seenByThread).toEqual({ t1: yield* seqOf("a2"), t2: yield* seqOf("b1") });
        expect((yield* streamState)?.backfilledAt).toBe("2026-10-28T12:00:00.000Z");
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
      yield* syncStream("mail", source, mailStream, fromMeTags);
      expect(yield* tagsByThread).toEqual([]);

      const aliased = { ...mailStream, me: [...mailStream.me, "ADA@example.com"] };
      yield* syncStream("mail", source, aliased, fromMeTags);
      expect(yield* tagsByThread).toEqual(["t1:sent"]);

      yield* syncStream("mail", source, mailStream, fromMeTags);
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
      );

      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-28T09:35:00Z")));
      const error = yield* Effect.flip(
        syncSource(
          "mail",
          failingStreams(() => Promise.reject(new Error("token revoked"))),
          tags,
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
      );
      yield* Effect.flip(
        syncSource(
          "mail",
          failingStreams(async () => [{ ...mailStream, extra: true }]),
          tags,
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
      );
      yield* Effect.flip(
        syncSource(
          "mail",
          failingStreams(() => Promise.reject(new Error("down"))),
          tags,
        ),
      );
      expect(yield* syncRuns).toHaveLength(1);
      expect((yield* streamState)?.lastError).toBeNull();
    }).pipe(Effect.provide(storeLayer())),
  );
});
