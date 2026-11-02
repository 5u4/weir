import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { RawItem } from "@weir/contract/Source";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { View } from "../src/Api.ts";
import * as Http from "../src/Http.ts";
import {
  apiClient,
  digestConfig,
  eventually,
  fakePlugin,
  fakeSource,
  makeHome,
  rawItem,
  sourceConfig,
} from "./harness.ts";

const group = (name: string, regex: string) => `
[[group]]
name = "${name}"
match = { type = "regex", target = "/title", regex = "${regex}", flags = "i" }
`;

const receipts = group("Receipts", "receipt");

const untagged: View = { _tag: "Untagged" };
const cleared: View = { _tag: "Cleared" };

const item = (externalId: string, thread: string, minute: number, title: string | null = null) =>
  rawItem(externalId, {
    threadId: thread,
    title,
    occurredAt: `2026-10-28T09:${String(minute).padStart(2, "0")}:00Z`,
    body: `note ${externalId}`,
    bodyNew: `note ${externalId}`,
  });

const start = Effect.gen(function* () {
  const source = fakeSource([]);
  const { home, port, writeConfig } = makeHome("");
  const base = sourceConfig() + digestConfig({ capture: join(home.root, "capture.jsonl") });
  writeConfig(base);
  yield* Layer.build(Http.layer(home, { fake: fakePlugin(source) }));
  const client = yield* apiClient(port);
  yield* eventually(client.status(), ({ sources }) =>
    sources.every(
      ({ streams }) => streams.length > 0 && streams.every(({ backfill }) => backfill === "done"),
    ),
  );
  const maxSeq = client
    .conversations({ query: { view: untagged } })
    .pipe(Effect.map(({ seq }) => seq));
  const deliver = (items: ReadonlyArray<RawItem>) =>
    Effect.gen(function* () {
      const before = yield* maxSeq;
      source.pending.push(...items);
      yield* eventually(maxSeq, (seq) => seq >= before + items.length);
    });
  const rows = Effect.gen(function* () {
    const open = yield* client.conversations({ query: { view: untagged } });
    const done = yield* client.conversations({ query: { view: cleared } });
    return [...open.conversations, ...done.conversations];
  });
  const rowOf = (title: string) =>
    Effect.map(rows, (all) => {
      const found = all.find((row) => row.title === title);
      if (found === undefined) throw new Error(`no conversation titled ${title}`);
      return found;
    });
  const detail = (id: number) => client.conversation({ params: { id } });
  const seqsOf = (id: number) => Effect.map(detail(id), ({ items }) => items.map(({ seq }) => seq));
  const configure = (groups: string) =>
    Effect.gen(function* () {
      writeConfig(base + groups);
      yield* client.reload();
    });
  return { client, deliver, rows, rowOf, detail, seqsOf, configure };
});

const lastOf = (seqs: ReadonlyArray<number>) => {
  const last = seqs.at(-1);
  if (last === undefined) throw new Error("expected items");
  return last;
};

const twoReceipts = Effect.gen(function* () {
  const served = yield* start;
  yield* served.deliver([
    item("a1", "ta", 1, "Receipt A"),
    item("a2", "ta", 2),
    item("b1", "tb", 3, "Receipt B"),
    item("b2", "tb", 4),
    item("c1", "tc", 5, "Lunch"),
  ]);
  const a = (yield* served.rowOf("Receipt A")).id;
  const b = (yield* served.rowOf("Receipt B")).id;
  const lunch = (yield* served.rowOf("Lunch")).id;
  const seqsA = yield* served.seqsOf(a);
  const seqsB = yield* served.seqsOf(b);
  return { ...served, a, b, lunch, seqsA, seqsB, lastA: lastOf(seqsA), lastB: lastOf(seqsB) };
});

describe("group", () => {
  it.live("a new rule collapses matching threads into one done row and hides the threads", () =>
    Effect.gen(function* () {
      const { client, rows, rowOf, detail, configure, a, b, lunch, seqsA, seqsB, lastA, lastB } =
        yield* twoReceipts;
      yield* client.done({ params: { id: a }, payload: { seq: lastA } });

      yield* configure(receipts);

      const g = (yield* rowOf("Receipts")).id;
      const merged = yield* detail(g);
      expect(merged.title).toBe("Receipts");
      expect(merged.items.map(({ seq }) => seq)).toEqual([...seqsA, ...seqsB]);
      expect(merged.state).toEqual({
        seen_seq: lastB,
        cleared_seq: lastB,
        muted: false,
        state: "done",
      });
      expect(merged.digests).toEqual([]);
      expect((yield* rows).map(({ id }) => id).sort()).toEqual([g, lunch].sort());
      expect((yield* Effect.flip(detail(a)))._tag).toBe("NotFound");
      expect((yield* Effect.flip(detail(b)))._tag).toBe("NotFound");
      expect((yield* detail(lunch)).state.state).toBe("unread");
    }).pipe(Effect.scoped),
  );

  it.live("widening a done group to a newer thread keeps it done", () =>
    Effect.gen(function* () {
      const { deliver, rowOf, detail, seqsOf, configure, lastB } = yield* twoReceipts;
      yield* configure(receipts);
      const g = (yield* rowOf("Receipts")).id;
      expect((yield* detail(g)).state).toMatchObject({ cleared_seq: lastB, state: "done" });

      yield* deliver([item("x1", "tx", 6, "Invoice X"), item("x2", "tx", 7)]);
      const x = (yield* rowOf("Invoice X")).id;
      const lastX = lastOf(yield* seqsOf(x));
      expect(lastX).toBeGreaterThan(lastB);

      yield* configure(group("Receipts", "receipt|invoice"));

      const widened = yield* detail(g);
      expect(widened.items).toHaveLength(6);
      expect(widened.state).toEqual({
        seen_seq: lastX,
        cleared_seq: lastX,
        muted: false,
        state: "done",
      });
      expect((yield* Effect.flip(detail(x)))._tag).toBe("NotFound");
    }).pipe(Effect.scoped),
  );

  it.live("removing the rule returns threads with their digests and state", () =>
    Effect.gen(function* () {
      const { client, rows, rowOf, detail, configure, a, b, lunch, seqsA, lastA, lastB } =
        yield* twoReceipts;
      const { digests } = yield* client.digest({ params: { id: a }, payload: {} });
      expect(digests.map(({ from_seq, to_seq }) => [from_seq, to_seq])).toEqual([
        [seqsA[0], lastA],
      ]);
      yield* client.done({ params: { id: a }, payload: { seq: lastA } });
      yield* client.unread({ params: { id: b }, payload: {} });

      yield* configure(receipts);
      const g = (yield* rowOf("Receipts")).id;
      yield* configure("");

      const backA = yield* detail(a);
      expect(backA.state).toEqual({
        seen_seq: 0,
        cleared_seq: lastA,
        muted: false,
        state: "done",
      });
      expect(backA.digests).toEqual(digests);
      const backB = yield* detail(b);
      expect(backB.state).toEqual({
        seen_seq: lastB - 1,
        cleared_seq: 0,
        muted: false,
        state: "unread",
      });
      expect((yield* Effect.flip(detail(g)))._tag).toBe("NotFound");
      expect((yield* rows).map(({ id }) => id).sort()).toEqual([a, b, lunch].sort());
    }).pipe(Effect.scoped),
  );

  it.live("a new matching thread resurfaces the group with only its item unread", () =>
    Effect.gen(function* () {
      const { deliver, rowOf, detail, configure, lastB } = yield* twoReceipts;
      yield* configure(receipts);
      const g = (yield* rowOf("Receipts")).id;

      yield* deliver([item("n1", "tn", 8, "Receipt N")]);

      const row = yield* rowOf("Receipts");
      expect(row).toMatchObject({ id: g, state: "unread", seen_seq: lastB, new: 1, items: 5 });
      expect((yield* detail(g)).items.map(({ title }) => title)).toContain("Receipt N");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a stored thread that starts matching joins the group with only the new item unread",
    () =>
      Effect.gen(function* () {
        const { deliver, rowOf, detail, seqsOf, configure } = yield* twoReceipts;
        yield* deliver([item("d1", "td", 6, "Order D"), item("d2", "td", 7)]);
        const d = (yield* rowOf("Order D")).id;
        const lastD = lastOf(yield* seqsOf(d));
        yield* configure(receipts);
        const g = (yield* rowOf("Receipts")).id;
        expect((yield* detail(g)).state.state).toBe("done");

        yield* deliver([item("d3", "td", 9, "Receipt for order D")]);

        const row = yield* rowOf("Receipts");
        expect(row).toMatchObject({ id: g, state: "unread", seen_seq: lastD, new: 1, items: 7 });
        expect((yield* Effect.flip(detail(d)))._tag).toBe("NotFound");
      }).pipe(Effect.scoped),
  );

  it.live("rejects a duplicate group name", () =>
    Effect.gen(function* () {
      const { client, configure } = yield* start;
      const error = yield* Effect.flip(configure(receipts + group("Receipts", "invoice")));
      expect(error._tag).toBe("ConfigInvalid");
      expect(error._tag === "ConfigInvalid" && error.message).toContain(
        'duplicate name "Receipts"',
      );
      expect((yield* client.status()).config.error?.message).toContain('["group"][1]["name"]');
    }).pipe(Effect.scoped),
  );
});
