import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { RawItem } from "@weir/contract/Source";
import * as Database from "@weir/store/Database";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import type { WeirHome } from "../src/Home.ts";
import * as Http from "../src/Http.ts";
import {
  adjustableClock,
  apiClient,
  type DigestOptions,
  digestConfig,
  eventually,
  type FakeSource,
  fakePlugin,
  fakeSource,
  makeHome,
  processesMentioning,
  rawItem,
  readCapture,
  sourceConfig,
} from "./harness.ts";

const tags = `
[[tag]]
name = "Work"
ai = true
match = { type = "regex", target = "/title", regex = "work", flags = "i" }

[[tag]]
name = "Lists"
match = { type = "regex", target = "/title", regex = "list", flags = "i" }
`;

const item = (externalId: string, title: string, chars: number, minute: number): RawItem => {
  const text = "word ".repeat(Math.ceil(chars / 5)).slice(0, chars);
  return rawItem(externalId, {
    threadId: title,
    title,
    occurredAt: `2030-01-01T09:${String(minute).padStart(2, "0")}:00Z`,
    body: text,
    bodyNew: text,
  });
};

const configFor = (options: DigestOptions) => sourceConfig() + digestConfig(options) + tags;

const storedDigests = (home: WeirHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [counts] = yield* sql<{ digests: number; fts: number }>`SELECT
      (SELECT count(*) FROM digest) AS digests,
      (SELECT count(*) FROM search_fts WHERE digest_id IS NOT NULL) AS fts`;
    return counts;
  }).pipe(Effect.provide(Database.layer(home.db)));

const serve = (home: WeirHome, port: number, source: FakeSource) =>
  Effect.gen(function* () {
    yield* Layer.build(Http.layer(home, { fake: fakePlugin(source) }));
    const client = yield* apiClient(port);
    yield* eventually(client.status(), ({ sources }) =>
      sources.every(
        ({ streams }) => streams.length > 0 && streams.every(({ backfill }) => backfill === "done"),
      ),
    );
    const maxSeq = client
      .conversations({ query: { view: { _tag: "Untagged" } } })
      .pipe(Effect.map(({ seq }) => seq));
    const deliver = (items: ReadonlyArray<RawItem>) =>
      Effect.gen(function* () {
        const before = yield* maxSeq;
        source.pending.push(...items);
        yield* eventually(maxSeq, (seq) => seq >= before + items.length);
      });
    const conversationOf = (title: string) =>
      client.search({ query: { q: "" } }).pipe(
        Effect.map(({ conversations }) => {
          const found = conversations.find((conversation) => conversation.title === title);
          if (found === undefined) throw new Error(`no conversation titled ${title}`);
          return found.id;
        }),
      );
    const detail = (id: number) => client.conversation({ params: { id } });
    return { client, deliver, conversationOf, detail };
  });

const start = (options: Omit<DigestOptions, "capture"> = {}) =>
  Effect.gen(function* () {
    const { home, port, writeConfig } = makeHome("");
    const capture = join(home.root, "capture.jsonl");
    writeConfig(configFor({ capture, ...options }));
    const source = fakeSource([]);
    const served = yield* serve(home, port, source);
    return {
      ...served,
      home,
      port,
      capture,
      source,
      calls: () => readCapture(capture),
      reconfigure: (next: Omit<DigestOptions, "capture">) =>
        writeConfig(configFor({ capture, ...next })),
    };
  });

const ranges = (
  digests: ReadonlyArray<{
    readonly from_seq: number;
    readonly to_seq: number;
    readonly trigger: string;
  }>,
) => digests.map(({ from_seq, to_seq, trigger }) => [from_seq, to_seq, trigger]);

describe("auto digest", () => {
  it.live("an AI conversation over the threshold gets one auto digest of [start, last]", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, calls } = yield* start();
      yield* deliver([
        item("w1", "Work plan", 400, 1),
        item("l1", "List news", 1500, 2),
        item("w2", "Work plan", 400, 3),
      ]);
      const work = yield* conversationOf("Work plan");
      expect((yield* detail(work)).digest).toEqual({
        backlog: { chars: 800, threshold: 1000 },
        last_failure: null,
      });
      expect((yield* detail(yield* conversationOf("List news"))).digest.backlog).toBeNull();

      yield* deliver([item("l2", "List news", 50, 4), item("w3", "Work plan", 200, 5)]);
      const digested = yield* eventually(detail(work), ({ digests }) => digests.length > 0);
      const [s1, s2, s3] = digested.items.map(({ seq }) => seq);
      if (s1 === undefined || s2 === undefined || s3 === undefined) throw new Error("3 items");
      expect(s2 - s1).toBeGreaterThan(1);
      expect(ranges(digested.digests)).toEqual([[s1, s3, "auto"]]);
      expect(digested.digest).toEqual({
        backlog: { chars: 0, threshold: 1000 },
        last_failure: null,
      });
      expect(
        calls().map(({ input }) => [
          input.conversation.id,
          input.range,
          input.items.map(({ seq }) => seq),
        ]),
      ).toEqual([[work, { from_seq: s1, to_seq: s3 }, [s1, s2, s3]]]);

      const { conversations } = yield* client.search({ query: { q: "条新消息" } });
      expect(
        conversations.map(({ id, hits }) => [
          id,
          hits.map(({ field, digest_id }) => [field, digest_id]),
        ]),
      ).toEqual([[work, [["headline", digested.digests[0]?.id]]]]);
    }).pipe(Effect.scoped),
  );

  it.live("an answer that fails validation is retried once with the validation error", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, calls, home, reconfigure } = yield* start({
        args: ["--invalid", "first"],
      });
      writeFileSync(join(home.root, "guide.md"), "Keep people's names in English.");
      reconfigure({ args: ["--invalid", "first"], guide: "guide.md" });
      yield* client.reload();
      yield* deliver([item("w1", "Work plan", 1100, 1)]);
      const work = yield* conversationOf("Work plan");
      const digested = yield* eventually(detail(work), ({ digests }) => digests.length > 0);
      const seq = digested.items[0]?.seq;
      expect(ranges(digested.digests)).toEqual([[seq, seq, "auto"]]);
      expect(calls().map(({ input, hasError }) => [input.range, hasError])).toEqual([
        [{ from_seq: seq, to_seq: seq }, false],
        [{ from_seq: seq, to_seq: seq }, true],
      ]);
      expect(calls().map(({ input }) => input.guide)).toEqual([
        "Keep people's names in English.",
        "Keep people's names in English.",
      ]);
      expect((yield* client.status()).digest?.last_run).toMatchObject({ written: 1, failed: 0 });
    }).pipe(Effect.scoped),
  );

  it.live("three failed attempts record the run and its log, and only new items retry", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, calls, home, source } = yield* start({
        args: ["--invalid", "always"],
      });
      const w1 = item("w1", "Work plan", 1100, 1);
      yield* deliver([w1]);
      const work = yield* conversationOf("Work plan");
      const failed = yield* eventually(detail(work), ({ digest }) => digest.last_failure !== null);
      const seq = failed.items[0]?.seq;
      const run = failed.digest.last_failure;
      expect(run).toMatchObject({
        conversation_id: work,
        from_seq: seq,
        to_seq: seq,
        trigger: "auto",
        ok: false,
      });
      expect(run?.error).toContain("attempt 3");
      const logPath = run?.log_path ?? "";
      expect(logPath.startsWith(home.digestLogs)).toBe(true);
      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, "utf8")).toContain("===== attempt 3");
      expect(calls().map(({ hasError }) => hasError)).toEqual([false, true, true]);
      expect(failed.digests).toEqual([]);
      expect((yield* client.status()).digest?.last_run).toMatchObject({
        written: 0,
        failed: 1,
        avg_ms: null,
      });

      const syncs = source.syncCalls;
      source.pending.push(w1);
      yield* eventually(
        Effect.sync(() => source.syncCalls),
        (count) => source.pending.length === 0 && count >= syncs + 3,
      );
      yield* Effect.sleep("500 millis");
      expect(calls()).toHaveLength(3);

      yield* deliver([item("w2", "Work plan", 10, 2)]);
      const retried = yield* eventually(Effect.sync(calls), (all) => all.length === 6);
      const last = (yield* detail(work)).items.at(-1)?.seq;
      expect(retried.slice(3).map(({ input }) => input.range)).toEqual([
        { from_seq: seq, to_seq: last },
        { from_seq: seq, to_seq: last },
        { from_seq: seq, to_seq: last },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a range over max_input becomes contiguous digests, each call seeing the previous one",
    () =>
      Effect.gen(function* () {
        const { deliver, conversationOf, detail, calls } = yield* start();
        yield* deliver([1, 2, 3, 4, 5].map((n) => item(`w${n}`, "Work plan", 10_000, n)));
        const work = yield* conversationOf("Work plan");
        const digested = yield* eventually(detail(work), ({ digests }) => digests.length === 3);
        const [s1, s2, s3, s4, s5] = digested.items.map(({ seq }) => seq);
        expect(ranges(digested.digests)).toEqual([
          [s1, s2, "auto"],
          [s3, s4, "auto"],
          [s5, s5, "auto"],
        ]);
        expect(
          calls().map(({ input }) =>
            input.context.map((entry) =>
              entry.kind === "digest" ? [entry.from_seq, entry.to_seq, entry.headline] : entry.seq,
            ),
          ),
        ).toEqual([
          [],
          [[s1, s2, digested.digests[0]?.headline]],
          [
            [s1, s2, digested.digests[0]?.headline],
            [s3, s4, digested.digests[1]?.headline],
          ],
        ]);
      }).pipe(Effect.scoped),
  );
});

describe("status", () => {
  it.live("last_run sums the digest runs of the last 24 hours by the daemon clock", () =>
    Effect.gen(function* () {
      const { clock, set } = yield* adjustableClock("2030-01-02T12:00:00Z");
      yield* Effect.gen(function* () {
        const { client, home } = yield* start();
        expect((yield* client.status()).digest?.last_run).toBeNull();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [startedAt, ms, ok] of [
            ["2030-01-02T11:00:00.000Z", 1000, 1],
            ["2030-01-02T10:00:00.000Z", 2001, 1],
            ["2030-01-01T12:30:00.000Z", 500, 0],
            ["2030-01-01T11:59:59.999Z", 9000, 1],
            ["2030-01-01T00:00:00.000Z", 700, 0],
          ] as const) {
            yield* sql`INSERT INTO digest_run
              (conversation_id, from_seq, to_seq, "trigger", ai, started_at, ms, ok, error, log_path)
              VALUES (1, 1, 1, 'auto', 'fake', ${startedAt}, ${ms}, ${ok}, NULL, NULL)`;
          }
        }).pipe(Effect.provide(Database.layer(home.db)));

        expect((yield* client.status()).digest?.last_run).toEqual({
          at: "2030-01-02T11:00:00.000Z",
          written: 2,
          failed: 1,
          avg_ms: 1501,
        });
        yield* set("2030-01-03T10:30:00Z");
        expect((yield* client.status()).digest?.last_run).toEqual({
          at: "2030-01-02T11:00:00.000Z",
          written: 1,
          failed: 0,
          avg_ms: 1000,
        });
        yield* set("2030-01-03T11:00:00.001Z");
        expect((yield* client.status()).digest?.last_run).toBeNull();
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, clock));
    }),
  );
});

describe("manual digest", () => {
  it.live("fills gaps, rejects covered or unknown targets, and redo replaces the row", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, home, reconfigure } = yield* start();
      yield* deliver([1, 2, 3].map((n) => item(`l${n}`, "List news", 100, n)));
      const id = yield* conversationOf("List news");
      const [s1, s2, s3] = (yield* detail(id)).items.map(({ seq }) => seq);
      if (s1 === undefined || s2 === undefined || s3 === undefined) throw new Error("3 items");

      const now = yield* client.digest({ params: { id }, payload: {} });
      expect(ranges(now.digests)).toEqual([[s1, s3, "manual"]]);
      const covered = yield* Effect.flip(client.digest({ params: { id }, payload: { from: s2 } }));
      expect(covered).toMatchObject({
        _tag: "DigestConflict",
        message: `#${s2} is already in a digest`,
      });
      const empty = yield* Effect.flip(client.digest({ params: { id }, payload: {} }));
      expect(empty).toMatchObject({
        _tag: "DigestConflict",
        message: "nothing after the last digest",
      });
      const unknown = yield* Effect.flip(client.digest({ params: { id: 999_999 }, payload: {} }));
      expect(unknown._tag).toBe("NotFound");

      yield* deliver([4, 5, 6].map((n) => item(`l${n}`, "List news", 100, n)));
      const [, , , s4, s5, s6] = (yield* detail(id)).items.map(({ seq }) => seq);
      if (s4 === undefined || s5 === undefined || s6 === undefined) throw new Error("6 items");
      const from = yield* client.digest({ params: { id }, payload: { from: s5 } });
      expect(ranges(from.digests)).toEqual([[s5, s6, "manual"]]);
      const upTo = yield* client.digest({ params: { id }, payload: { up_to: s4 } });
      expect(ranges(upTo.digests)).toEqual([[s4, s4, "manual"]]);

      const old = now.digests[0];
      if (old === undefined) throw new Error("expected a digest");
      const redone = yield* client.redo({ params: { id: old.id } });
      expect(ranges(redone.digests)).toEqual([[s1, s3, "manual"]]);
      const fresh = redone.digests[0]?.id;
      expect(fresh).not.toBe(old.id);
      expect((yield* detail(id)).digests.map((digest) => digest.id)).not.toContain(old.id);
      const ftsRows = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ rowid: number; digestId: number }>`SELECT rowid, digest_id
          FROM search_fts WHERE digest_id IS NOT NULL ORDER BY digest_id`;
      }).pipe(Effect.provide(Database.layer(home.db)));
      expect(ftsRows.map(({ digestId }) => digestId)).not.toContain(old.id);
      expect(ftsRows).toContainEqual({ rowid: -(fresh ?? 0), digestId: fresh });
      const { conversations } = yield* client.search({ query: { q: "条新消息" } });
      expect(
        conversations.flatMap(({ hits }) => hits.map(({ digest_id }) => digest_id)),
      ).not.toContain(old.id);
      expect((yield* Effect.flip(client.redo({ params: { id: old.id } })))._tag).toBe("NotFound");

      reconfigure({ args: ["--exit", "1"] });
      yield* client.reload();
      yield* deliver([item("l7", "List news", 100, 7)]);
      const failed = yield* Effect.flip(client.digest({ params: { id }, payload: {} }));
      if (failed._tag !== "DigestFailed")
        throw new Error(`expected DigestFailed, got ${failed._tag}`);
      expect(failed.error).toContain("exit 1");
      expect(existsSync(failed.log_path ?? "")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("a later chunk that fails answers 502 and keeps the chunks written before it", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, calls } = yield* start({
        wrap: ["sh", "-c", 'if [ -s "$3" ]; then exec "$@" --exit 1; fi; exec "$@"', "fake-ai"],
      });
      yield* deliver([1, 2, 3].map((n) => item(`l${n}`, "List news", 10_000, n)));
      const id = yield* conversationOf("List news");
      const [s1, s2, s3] = (yield* detail(id)).items.map(({ seq }) => seq);

      const failed = yield* Effect.flip(client.digest({ params: { id }, payload: {} }));
      if (failed._tag !== "DigestFailed")
        throw new Error(`expected DigestFailed, got ${failed._tag}`);
      expect(failed.error).toContain("exit 1");
      expect(readFileSync(failed.log_path ?? "", "utf8")).toContain("===== attempt 3");
      expect(calls().map(({ input }) => input.range)).toEqual([
        { from_seq: s1, to_seq: s2 },
        { from_seq: s3, to_seq: s3 },
        { from_seq: s3, to_seq: s3 },
        { from_seq: s3, to_seq: s3 },
      ]);
      expect(ranges((yield* detail(id)).digests)).toEqual([[s1, s2, "manual"]]);
    }).pipe(Effect.scoped),
  );

  it.live("redo of a range over the current max_input answers 409 without calling the AI", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, calls, reconfigure } = yield* start();
      yield* deliver([1, 2].map((n) => item(`l${n}`, "List news", 10_000, n)));
      const id = yield* conversationOf("List news");
      const [s1, s2] = (yield* detail(id)).items.map(({ seq }) => seq);
      const { digests } = yield* client.digest({ params: { id }, payload: {} });
      const old = digests[0];
      if (old === undefined) throw new Error("expected a digest");
      expect(ranges(digests)).toEqual([[s1, s2, "manual"]]);

      reconfigure({ maxInput: 15_000 });
      yield* client.reload();
      const rejected = yield* Effect.flip(client.redo({ params: { id: old.id } }));
      expect(rejected).toMatchObject({
        _tag: "DigestConflict",
        message: `#${s1}-#${s2} is over max_input 15000; raise max_input to redo it`,
      });
      expect(calls()).toHaveLength(1);
      expect((yield* detail(id)).digests).toEqual([old]);
    }).pipe(Effect.scoped),
  );

  it.live("one conversation runs one call at a time; two conversations overlap", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, calls } = yield* start({
        args: ["--delay", "300"],
        concurrency: 2,
      });
      yield* deliver([item("a1", "List A", 100, 1), item("b1", "List B", 100, 2)]);
      const a = yield* conversationOf("List A");
      const b = yield* conversationOf("List B");

      const both = yield* Effect.all(
        [
          Effect.result(client.digest({ params: { id: a }, payload: {} })),
          Effect.result(client.digest({ params: { id: a }, payload: {} })),
        ],
        { concurrency: "unbounded" },
      );
      expect(both.filter(Result.isSuccess)).toHaveLength(1);
      expect(
        both.flatMap((result) => (Result.isFailure(result) ? [result.failure] : [])),
      ).toMatchObject([{ _tag: "DigestConflict", message: "nothing after the last digest" }]);
      expect(calls()).toHaveLength(1);

      yield* deliver([item("a2", "List A", 100, 3)]);
      const fiber = yield* Effect.forkChild(
        Effect.all(
          [
            client.digest({ params: { id: a }, payload: {} }),
            client.digest({ params: { id: b }, payload: {} }),
          ],
          { concurrency: "unbounded" },
        ),
      );
      const busy = yield* eventually(
        client.status(),
        ({ digest }) => (digest?.running.length ?? 0) === 2,
      );
      expect(busy.digest?.running.map(({ conversation_id }) => conversation_id).toSorted()).toEqual(
        [a, b].toSorted(),
      );
      const written = yield* Fiber.join(fiber);
      expect(written.map(({ digests }) => digests.length)).toEqual([1, 1]);
    }).pipe(Effect.scoped),
  );
});

describe("cancellation", () => {
  it.live("reload and shutdown kill the AI call and write nothing; a restart writes it once", () =>
    Effect.gen(function* () {
      const { home, port, writeConfig } = makeHome("");
      const [first, second, third] = ["a", "b", "c"].map((name) =>
        join(home.root, `${name}.jsonl`),
      );
      if (first === undefined || second === undefined || third === undefined) throw new Error();
      writeConfig(configFor({ capture: first, args: ["--delay", "10000"] }));
      const source = fakeSource([]);
      yield* Effect.gen(function* () {
        const { client, deliver } = yield* serve(home, port, source);
        yield* deliver([item("w1", "Work plan", 1100, 1)]);
        yield* eventually(
          Effect.sync(() => readCapture(first)),
          (all) => all.length === 1,
        );
        expect(processesMentioning(first)).toHaveLength(1);

        writeConfig(configFor({ capture: second, args: ["--delay", "10000"] }));
        yield* client.reload();
        expect(processesMentioning(first)).toEqual([]);
        expect(yield* storedDigests(home)).toEqual({ digests: 0, fts: 0 });
        yield* eventually(
          Effect.sync(() => readCapture(second)),
          (all) => all.length === 1,
        );
        expect(readCapture(second)[0]?.input.range).toEqual(readCapture(first)[0]?.input.range);
        expect(processesMentioning(second)).toHaveLength(1);
      }).pipe(Effect.scoped);
      expect(processesMentioning(second)).toEqual([]);
      expect(yield* storedDigests(home)).toEqual({ digests: 0, fts: 0 });

      writeConfig(configFor({ capture: third }));
      yield* Effect.gen(function* () {
        const { conversationOf, detail } = yield* serve(home, port, source);
        const work = yield* conversationOf("Work plan");
        const digested = yield* eventually(detail(work), ({ digests }) => digests.length > 0);
        const range = readCapture(first)[0]?.input.range;
        expect(ranges(digested.digests)).toEqual([[range?.from_seq, range?.to_seq, "auto"]]);
        expect(yield* storedDigests(home)).toEqual({ digests: 1, fts: 1 });
        expect(readCapture(third)).toHaveLength(1);
      }).pipe(Effect.scoped);
    }),
  );

  it.live("reload answers a held manual digest with 503 and the range digests again", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, detail, home, port, capture, calls, reconfigure } =
        yield* start({ args: ["--delay", "10000"] });
      yield* deliver([item("l1", "List news", 100, 1)]);
      const id = yield* conversationOf("List news");
      const held = yield* Effect.forkChild(
        Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/conversations/${id}/digest`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          return { status: response.status, body: await response.json() };
        }),
      );
      yield* eventually(Effect.sync(calls), (all) => all.length === 1);
      expect(processesMentioning(capture)).toHaveLength(1);

      reconfigure({});
      yield* client.reload();
      expect(yield* Fiber.join(held)).toEqual({
        status: 503,
        body: {
          _tag: "DigestInterrupted",
          message: "the digest was interrupted by a reload or shutdown; try again",
        },
      });
      expect(processesMentioning(capture)).toEqual([]);
      expect(yield* storedDigests(home)).toEqual({ digests: 0, fts: 0 });
      expect((yield* client.status()).digest?.last_run).toBeNull();

      const seq = (yield* detail(id)).items[0]?.seq;
      const retried = yield* client.digest({ params: { id }, payload: {} });
      expect(ranges(retried.digests)).toEqual([[seq, seq, "manual"]]);
      expect(yield* storedDigests(home)).toEqual({ digests: 1, fts: 1 });
    }).pipe(Effect.scoped),
  );
});
