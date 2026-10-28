import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { type SearchQuery, search } from "../src/Read.ts";
import { softDeleteItems, upsertStream, writeItems } from "../src/Write.ts";
import { mailStream, rawItem, storeLayer } from "./fixtures.ts";

const matches = (query: SearchQuery) =>
  search(query).pipe(Effect.map((conversations) => new Set(conversations.map(({ id }) => id))));

const writeBodies = Effect.fnUntraced(function* (bodies: ReadonlyArray<string>) {
  const { stream } = yield* upsertStream("mail", mailStream);
  const written = yield* writeItems(
    stream,
    bodies.map((body, index) => rawItem(`m${index}`, { bodyNew: body })),
  );
  return written.map(({ conversationId }) => conversationId);
});

describe("search", () => {
  it.effect("finds substrings of 3+ characters case-insensitively via trigrams", () =>
    Effect.gen(function* () {
      const [migration] = yield* writeBodies(["Schema migration is done", "Unrelated note"]);
      expect(yield* matches({ query: "migrat" })).toEqual(new Set([migration]));
      expect(yield* matches({ query: "MIGRAT" })).toEqual(new Set([migration]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("finds terms shorter than 3 characters by substring", () =>
    Effect.gen(function* () {
      const [quote, pr] = yield* writeBodies(["请看保险报价单", "Merged PR #4821", "Lunch?"]);
      expect(yield* matches({ query: "报价" })).toEqual(new Set([quote]));
      expect(yield* matches({ query: "PR" })).toEqual(new Set([pr]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("treats % and _ as literal characters", () =>
    Effect.gen(function* () {
      const [percent, underscore] = yield* writeBodies([
        "100% done",
        "snake_case name",
        "plain words",
      ]);
      expect(yield* matches({ query: "%" })).toEqual(new Set([percent]));
      expect(yield* matches({ query: "_" })).toEqual(new Set([underscore]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("treats FTS syntax in a term as literal text", () =>
    Effect.gen(function* () {
      const [quoted] = yield* writeBodies(['say "hi" NEAR bye', "hi there"]);
      expect(yield* matches({ query: '"hi" NEAR' })).toEqual(new Set([quoted]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("requires every term somewhere in the same conversation", () =>
    Effect.gen(function* () {
      const { stream } = yield* upsertStream("mail", mailStream);
      const [both] = yield* writeItems(stream, [
        rawItem("a", { threadId: "both", bodyNew: "idempotency keys" }),
        rawItem("b", { threadId: "both", bodyNew: "backfill job" }),
        rawItem("c", { threadId: "one", bodyNew: "idempotency only" }),
      ]);
      expect(yield* matches({ query: "idempotency  backfill" })).toEqual(
        new Set([both?.conversationId]),
      );
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a soft-deleted item stops matching until it is upserted again", () =>
    Effect.gen(function* () {
      const { stream } = yield* upsertStream("mail", mailStream);
      const item = rawItem("m1", { bodyNew: "migration plan" });
      const [written] = yield* writeItems(stream, [item]);

      expect(yield* softDeleteItems(stream.id, ["m1"])).toEqual([written?.conversationId]);
      expect(yield* matches({ query: "migration" })).toEqual(new Set());
      expect(yield* matches({ query: "" })).toEqual(new Set());

      yield* writeItems(stream, [item]);
      expect(yield* matches({ query: "migration" })).toEqual(new Set([written?.conversationId]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("indexes only the new text, not quoted history", () =>
    Effect.gen(function* () {
      const { stream } = yield* upsertStream("mail", mailStream);
      const [reply] = yield* writeItems(stream, [
        rawItem("m1", { body: "fresh reply\n\n> Northwind cutover", bodyNew: "fresh reply" }),
      ]);
      expect(yield* matches({ query: "Northwind" })).toEqual(new Set());
      expect(yield* matches({ query: "fresh" })).toEqual(new Set([reply?.conversationId]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("renaming a stream reindexes its live items under the new name", () =>
    Effect.gen(function* () {
      const { stream } = yield* upsertStream("mail", mailStream);
      const [live] = yield* writeItems(stream, [
        rawItem("live", { threadId: "live", bodyNew: "status report" }),
        rawItem("gone", { threadId: "gone", bodyNew: "status report" }),
      ]);
      yield* softDeleteItems(stream.id, ["gone"]);

      yield* upsertStream("mail", { ...mailStream, name: "Personal inbox" });
      expect(yield* matches({ query: "Personal" })).toEqual(new Set([live?.conversationId]));
      expect(yield* matches({ query: "Work" })).toEqual(new Set());
      expect(yield* matches({ query: "status" })).toEqual(new Set([live?.conversationId]));
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("orders results by their newest matching item, not their newest item", () =>
    Effect.gen(function* () {
      const { stream } = yield* upsertStream("mail", mailStream);
      const [olderMatch, , newerMatch] = yield* writeItems(stream, [
        rawItem("a1", {
          threadId: "a",
          bodyNew: "invoice due",
          occurredAt: "2026-10-28T09:00:00Z",
        }),
        rawItem("a2", { threadId: "a", bodyNew: "thanks", occurredAt: "2026-10-28T12:00:00Z" }),
        rawItem("b1", {
          threadId: "b",
          bodyNew: "invoice sent",
          occurredAt: "2026-10-28T10:00:00Z",
        }),
      ]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO search_fts (text, conversation_id, item_seq, digest_id)
        VALUES ('invoice digest', ${olderMatch?.conversationId}, NULL, 1)`;

      const ids = (query: SearchQuery) =>
        Effect.map(search(query), (conversations) => conversations.map(({ id }) => id));
      expect(yield* ids({ query: "invoice", limit: 1 })).toEqual([newerMatch?.conversationId]);
      expect(yield* ids({ query: "invoice" })).toEqual([
        newerMatch?.conversationId,
        olderMatch?.conversationId,
      ]);
      expect(yield* ids({ query: "" })).toEqual([
        olderMatch?.conversationId,
        newerMatch?.conversationId,
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("tag, source, from and since each narrow the results", () =>
    Effect.gen(function* () {
      const { stream: work } = yield* upsertStream("work", mailStream);
      const { stream: home } = yield* upsertStream("home", {
        ...mailStream,
        id: "home@example.com",
      });
      const [ada, bob] = yield* writeItems(work, [
        rawItem("ada", {
          bodyNew: "status report",
          from: { name: "Ada Lovelace", address: "ada@example.com" },
          occurredAt: "2026-10-27T09:00:00Z",
        }),
        rawItem("bob", {
          bodyNew: "status report",
          from: { name: "Bob", address: "bob@corp.example" },
          occurredAt: "2026-10-28T09:00:00Z",
        }),
      ]);
      const [carol] = yield* writeItems(home, [
        rawItem("carol", {
          bodyNew: "status report",
          from: { name: "Carol", address: "carol@home.example" },
          occurredAt: "2026-10-28T10:00:00Z",
        }),
      ]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO conversation_tag (conversation_id, tag)
        VALUES (${bob?.conversationId}, 'urgent')`;

      expect(yield* matches({ query: "status" })).toEqual(
        new Set([ada?.conversationId, bob?.conversationId, carol?.conversationId]),
      );
      expect(yield* matches({ query: "status", tag: { _tag: "Named", name: "urgent" } })).toEqual(
        new Set([bob?.conversationId]),
      );
      expect(yield* matches({ query: "status", source: "home" })).toEqual(
        new Set([carol?.conversationId]),
      );
      expect(yield* matches({ query: "status", from: "LOVELACE" })).toEqual(
        new Set([ada?.conversationId]),
      );
      expect(yield* matches({ query: "status", from: "corp.example" })).toEqual(
        new Set([bob?.conversationId]),
      );
      expect(
        yield* matches({ query: "", since: DateTime.makeUnsafe("2026-10-28T00:00:00Z") }),
      ).toEqual(new Set([bob?.conversationId, carol?.conversationId]));
    }).pipe(Effect.provide(storeLayer())),
  );
});
