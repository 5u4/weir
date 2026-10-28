import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Database from "../src/Database.ts";
import { getConversation, getItem, search } from "../src/Read.ts";
import { softDeleteItems, upsertStream, writeItems } from "../src/Write.ts";
import { mailStream, rawItem, storeLayer, tempDbFile } from "./fixtures.ts";

const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.all([
    sql`SELECT * FROM item ORDER BY seq`,
    sql`SELECT * FROM conversation ORDER BY id`,
    sql`SELECT rowid, * FROM search_fts ORDER BY rowid`,
  ]);
});

describe("store items", () => {
  it.effect("rerunning migrations on an existing file applies nothing and keeps data", () =>
    Effect.gen(function* () {
      const file = tempDbFile();
      const [written] = yield* Effect.gen(function* () {
        const stream = yield* upsertStream("mail", mailStream);
        return yield* writeItems(stream, [rawItem("m1", { body: "kept" })]);
      }).pipe(Effect.provide(Database.layer(file)));
      if (written === undefined) return expect.unreachable();

      const [applied, item] = yield* Effect.all([Database.migrate, getItem(written.seq)]).pipe(
        Effect.provide(Database.layer(file)),
      );
      expect(applied).toEqual([]);
      expect(Option.map(item, ({ body }) => body)).toEqual(Option.some("kept"));
    }),
  );

  it.effect("re-upserting an item keeps its seq and replaces its content", () =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      const [first] = yield* writeItems(stream, [rawItem("m1", { body: "draft" })]);
      const [second] = yield* writeItems(stream, [rawItem("m1", { body: "final" })]);
      if (first === undefined || second === undefined) return expect.unreachable();

      expect(first.inserted).toBe(true);
      expect(second).toEqual({ ...first, inserted: false });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ seq: number; body: string }>`SELECT seq, body FROM item`;
      expect(rows).toEqual([{ seq: first.seq, body: "final" }]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("marks items from the stream's own addresses case-insensitively", () =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      const [mine, theirs] = yield* writeItems(stream, [
        rawItem("m1", { from: { name: "Me", address: "me@EXAMPLE.com" } }),
        rawItem("m2"),
      ]);
      if (mine === undefined || theirs === undefined) return expect.unreachable();

      const fromMe = yield* Effect.forEach([mine, theirs], ({ seq }) =>
        getItem(seq).pipe(Effect.map(Option.map((item) => item.fromMe))),
      );
      expect(fromMe).toEqual([Option.some(true), Option.some(false)]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("stamps synced_at from the Clock", () =>
    Effect.gen(function* () {
      const now = DateTime.makeUnsafe("2026-10-28T12:34:56.789Z");
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const stream = yield* upsertStream("mail", mailStream);
      const [written] = yield* writeItems(stream, [rawItem("m1")]);
      if (written === undefined) return expect.unreachable();

      const item = yield* getItem(written.seq);
      expect(Option.map(item, ({ syncedAt }) => DateTime.formatIso(syncedAt))).toEqual(
        Option.some("2026-10-28T12:34:56.789Z"),
      );
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("stores offset timestamps as UTC so conversations order by real time", () =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      const [early, late] = yield* writeItems(stream, [
        rawItem("early", { occurredAt: "2026-10-28T10:30:00+02:00" }),
        rawItem("late", { occurredAt: "2026-10-28T09:00:00Z" }),
      ]);
      if (early === undefined || late === undefined) return expect.unreachable();

      const sql = yield* SqlClient.SqlClient;
      const stored = yield* sql<{
        occurredAt: string;
      }>`SELECT occurred_at FROM item WHERE seq = ${early.seq}`;
      expect(stored).toEqual([{ occurredAt: "2026-10-28T08:30:00.000Z" }]);

      const conversations = yield* search({ query: "" });
      expect(conversations.map(({ id }) => id)).toEqual([
        late.conversationId,
        early.conversationId,
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect.each([
    ["occurred_at", "garbage"],
    ["from_me", 7],
  ] as const)("a stored %s of %s fails getItem with a SchemaError", ([column, value]) =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      const [written] = yield* writeItems(stream, [rawItem("m1")]);
      if (written === undefined) return expect.unreachable();

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE item SET ${sql(column)} = ${value} WHERE seq = ${written.seq}`;
      const error = yield* Effect.flip(getItem(written.seq));
      expect(error._tag).toBe("SchemaError");
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("conversation aggregates follow live items, including an item that moves away", () =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      const opener = rawItem("a", { threadId: "t1", occurredAt: "2026-10-28T09:00:00Z" });
      const reply = rawItem("b", {
        threadId: "t1",
        title: "Re: plan",
        occurredAt: "2026-10-28T10:00:00Z",
      });
      const late = rawItem("c", {
        threadId: "t1",
        title: "Late",
        containerName: "Team chat",
        occurredAt: "2026-10-28T11:00:00Z",
      });
      const [a, b, c] = yield* writeItems(stream, [opener, reply, late]);
      if (a === undefined || b === undefined || c === undefined) return expect.unreachable();

      const summary = Effect.map(
        getConversation(a.conversationId),
        Option.map(({ conversation, items }) => ({
          title: conversation.title,
          firstAt: DateTime.formatIso(conversation.firstAt),
          lastAt: DateTime.formatIso(conversation.lastAt),
          lastSeq: conversation.lastSeq,
          items: items.map(({ seq }) => seq),
        })),
      );
      expect(yield* summary).toEqual(
        Option.some({
          title: "Re: plan",
          firstAt: "2026-10-28T09:00:00.000Z",
          lastAt: "2026-10-28T11:00:00.000Z",
          lastSeq: c.seq,
          items: [a.seq, b.seq, c.seq],
        }),
      );

      const [moved] = yield* writeItems(stream, [{ ...late, threadId: "t2", title: null }]);
      expect(yield* summary).toEqual(
        Option.some({
          title: "Re: plan",
          firstAt: "2026-10-28T09:00:00.000Z",
          lastAt: "2026-10-28T10:00:00.000Z",
          lastSeq: b.seq,
          items: [a.seq, b.seq],
        }),
      );
      const movedTo = yield* getConversation(moved?.conversationId ?? a.conversationId);
      expect(Option.map(movedTo, ({ conversation }) => conversation.title)).toEqual(
        Option.some("Team chat"),
      );
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a batch that fails partway leaves items, conversations and search untouched", () =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      yield* writeItems(stream, [rawItem("a", { threadId: "t1", bodyNew: "kept" })]);
      const before = yield* snapshot;

      const error = yield* Effect.flip(
        writeItems(stream, [
          rawItem("a", { threadId: "t2", bodyNew: "moved" }),
          rawItem("b", { bodyNew: "new" }),
          rawItem("c", { raw: { id: 1n } }),
        ]),
      );
      expect(error._tag).toBe("SchemaError");
      expect(yield* snapshot).toEqual(before);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a soft delete that fails after marking items rolls the marks back", () =>
    Effect.gen(function* () {
      const stream = yield* upsertStream("mail", mailStream);
      yield* writeItems(stream, [rawItem("m1")]);
      const sql = yield* SqlClient.SqlClient;
      const items = sql`SELECT * FROM item`;
      const before = yield* items;

      yield* sql`DROP TABLE search_fts`;
      const error = yield* Effect.flip(softDeleteItems(stream.id, ["m1"]));
      expect(error._tag).toBe("SqlError");
      expect(yield* items).toEqual(before);
    }).pipe(Effect.provide(storeLayer())),
  );
});
