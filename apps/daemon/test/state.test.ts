import { describe, expect, it } from "@effect/vitest";
import type { RawItem } from "@weir/contract/Source";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { View } from "../src/Api.ts";
import * as Http from "../src/Http.ts";
import {
  apiClient,
  eventually,
  fakePlugin,
  fakeSource,
  makeHome,
  rawItem,
  sourceConfig,
} from "./harness.ts";

const tag = (name: string, match: string) => `
[[tag]]
name = "${name}"
match = ${match}
`;

const config =
  sourceConfig() +
  tag("Work", `{ type = "regex", target = "/title", regex = "work", flags = "i" }`) +
  tag("Lists", `{ type = "regex", target = "/from/address", regex = "lists" }`);

const work: View = { _tag: "Tag", name: "Work" };
const lists: View = { _tag: "Tag", name: "Lists" };
const untagged: View = { _tag: "Untagged" };
const cleared: View = { _tag: "Cleared" };

const item = (externalId: string, thread: string, minute: number, overrides: Partial<RawItem>) =>
  rawItem(externalId, {
    threadId: thread,
    occurredAt: `2026-10-28T09:${String(minute).padStart(2, "0")}:00Z`,
    ...overrides,
  });

const start = Effect.gen(function* () {
  const source = fakeSource([]);
  const { home, port } = makeHome(config);
  yield* Layer.build(Http.layer(home, { fake: fakePlugin(source) }));
  const client = yield* apiClient(port);
  yield* eventually(client.status(), ({ sources }) =>
    sources.every(
      ({ streams }) => streams.length > 0 && streams.every(({ backfill }) => backfill === "done"),
    ),
  );
  const listed = (view: View) =>
    client
      .conversations({ query: { view } })
      .pipe(Effect.map(({ conversations }) => conversations));
  const deliver = (items: ReadonlyArray<RawItem>) =>
    Effect.gen(function* () {
      const { seq } = yield* client.conversations({ query: { view: untagged } });
      source.pending.push(...items);
      yield* eventually(
        client.conversations({ query: { view: untagged } }),
        (list) => list.seq >= seq + items.length,
      );
    });
  const conversationOf = (title: string) =>
    client.search({ query: { q: "" } }).pipe(
      Effect.map(({ conversations }) => {
        const found = conversations.find((conversation) => conversation.title === title);
        if (found === undefined) throw new Error(`no conversation titled ${title}`);
        return found.id;
      }),
    );
  const seqsOf = (id: number) =>
    client
      .conversation({ params: { id } })
      .pipe(Effect.map(({ items }) => items.map(({ seq }) => seq)));
  return { client, port, listed, deliver, conversationOf, seqsOf };
});

const ids = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map(({ id }) => id);
const states = (rows: ReadonlyArray<{ readonly id: number; readonly state: string }>) =>
  rows.map(({ id, state }) => [id, state]);

describe("conversation state", () => {
  it.live("read advances seen_seq up to the last item and never lowers it", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("a1", "t1", 1, { title: "Work plan" }),
        item("a2", "t1", 2, { title: "Re: Work plan" }),
      ]);
      const id = yield* conversationOf("Work plan");
      const [s1, s2] = yield* seqsOf(id);
      if (s1 === undefined || s2 === undefined) throw new Error("expected two items");

      const first = yield* client.read({ params: { id }, payload: { seq: s1 } });
      expect(first).toMatchObject({ state: "unread", seen_seq: s1, new: 1, items: 2 });

      const lower = yield* client.read({ params: { id }, payload: { seq: s1 - 1 } });
      expect(lower).toMatchObject({ state: "unread", seen_seq: s1, new: 1 });

      const clamped = yield* client.read({ params: { id }, payload: { seq: s2 + 100 } });
      expect(clamped).toMatchObject({ state: "read", seen_seq: s2, last_seq: s2, new: 0 });

      const detail = yield* client.conversation({ params: { id } });
      expect(detail.state).toEqual({ seen_seq: s2, cleared_seq: 0, muted: false, state: "read" });
      expect(detail.digests).toEqual([]);

      yield* deliver([item("a3", "t1", 3, { title: "Re: Work plan" })]);
      const reopened = yield* client.conversation({ params: { id } });
      expect(reopened.state).toMatchObject({ seen_seq: s2, state: "unread" });
    }).pipe(Effect.scoped),
  );

  it.live("unread moves seen_seq to just before the last or the given item", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("b1", "t1", 1, { title: "Work sync" }),
        item("b2", "t1", 2, {}),
        item("b3", "t1", 3, {}),
      ]);
      const id = yield* conversationOf("Work sync");
      const [s1, , s3] = yield* seqsOf(id);
      if (s1 === undefined || s3 === undefined) throw new Error("expected three items");
      yield* client.read({ params: { id }, payload: { seq: s3 } });

      const last = yield* client.unread({ params: { id }, payload: {} });
      expect(last).toMatchObject({ state: "unread", seen_seq: s3 - 1, new: 1 });

      const fromFirst = yield* client.unread({ params: { id }, payload: { seq: s1 } });
      expect(fromFirst).toMatchObject({ state: "unread", seen_seq: s1 - 1, new: 3, items: 3 });
    }).pipe(Effect.scoped),
  );

  it.live("done hides a conversation until a newer item arrives, restore brings it back read", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([item("c1", "t1", 1, { title: "Work review" }), item("c2", "t1", 2, {})]);
      const id = yield* conversationOf("Work review");
      const [, s2] = yield* seqsOf(id);
      if (s2 === undefined) throw new Error("expected two items");

      const done = yield* client.done({ params: { id }, payload: { seq: s2 } });
      expect(done).toMatchObject({ state: "done", cleared_seq: s2 });
      expect(ids(yield* listed(work))).toEqual([]);
      expect(states(yield* listed(cleared))).toEqual([[id, "done"]]);
      expect((yield* client.counts()).cleared).toBe(1);

      yield* deliver([item("c3", "t1", 3, {})]);
      expect(states(yield* listed(work))).toEqual([[id, "unread"]]);
      expect(ids(yield* listed(cleared))).toEqual([]);

      const stale = yield* client.done({ params: { id }, payload: { seq: s2 } });
      expect(stale.state).toBe("unread");
      expect(ids(yield* listed(work))).toEqual([id]);

      yield* client.done({ params: { id }, payload: { seq: stale.last_seq } });
      const restored = yield* client.restore({ params: { id } });
      expect(restored).toMatchObject({ state: "read", cleared_seq: 0, seen_seq: stale.last_seq });
      expect(ids(yield* listed(work))).toEqual([id]);
    }).pipe(Effect.scoped),
  );

  it.live("a muted conversation stays cleared and out of unread counts until restored", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf } = yield* start;
      yield* deliver([item("d1", "t1", 1, { title: "Work chatter" })]);
      const id = yield* conversationOf("Work chatter");

      const muted = yield* client.mute({ params: { id } });
      expect(muted).toMatchObject({ state: "muted", muted: true });

      yield* deliver([item("d2", "t1", 2, {})]);
      expect(states(yield* listed(cleared))).toEqual([[id, "muted"]]);
      expect(ids(yield* listed(work))).toEqual([]);
      const counts = yield* client.counts();
      expect(counts.unread).toBe(0);
      expect(counts.tags.find(({ name }) => name === "Work")).toMatchObject({
        unread: 0,
        open: 0,
      });

      const restored = yield* client.restore({ params: { id } });
      expect(restored).toMatchObject({ state: "read", muted: false, new: 0 });
      expect(ids(yield* listed(work))).toEqual([id]);
    }).pipe(Effect.scoped),
  );

  it.live("clear marks only the view's conversations done up to the given seq", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf } = yield* start;
      yield* deliver([
        item("e1", "w1", 1, { title: "Work one" }),
        item("e2", "w2", 2, { title: "Work two" }),
        item("e3", "l1", 3, {
          title: "Digest",
          from: { name: "L", address: "news@lists.example" },
        }),
        item("e4", "u1", 4, { title: "Hello" }),
        item("e5", "u2", 5, { title: "Read already" }),
      ]);
      const workOne = yield* conversationOf("Work one");
      const workTwo = yield* conversationOf("Work two");
      const list = yield* conversationOf("Digest");
      const hello = yield* conversationOf("Hello");
      const readAlready = yield* conversationOf("Read already");
      const readRow = yield* client.read({
        params: { id: readAlready },
        payload: { seq: 1_000_000 },
      });
      expect(readRow.state).toBe("read");

      const others = Effect.all([listed(lists), listed(untagged), listed(cleared)]);
      const before = yield* others;
      expect(ids(before[0])).toEqual([list]);
      expect(ids(before[1]).toSorted()).toEqual([hello, readAlready].toSorted());
      expect(before[2]).toEqual([]);

      const { seq } = yield* client.conversations({ query: { view: work } });
      yield* deliver([item("e6", "w2", 6, {})]);

      expect(yield* client.clear({ payload: { view: work, seq } })).toEqual({ cleared: 1 });
      expect(states(yield* listed(work))).toEqual([[workTwo, "unread"]]);
      const after = yield* others;
      expect(after[0]).toEqual(before[0]);
      expect(after[1]).toEqual(before[1]);
      expect(states(after[2])).toEqual([[workOne, "done"]]);
    }).pipe(Effect.scoped),
  );
});

describe("views and counts", () => {
  it.live("a two-tag conversation counts in both tags and once in total", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf } = yield* start;
      yield* deliver([
        item("f1", "both", 1, {
          title: "Work list",
          from: { name: "List bot", address: "bot@lists.example" },
        }),
        item("f2", "work", 2, {
          title: "Work only",
          from: { name: "Ada", address: "ada@x.example" },
        }),
        item("f3", "work", 3, { from: { name: "Me", address: "me@example.com" } }),
        item("f4", "none", 4, {
          title: "Untagged hi",
          from: { name: "Bo", address: "bo@x.example" },
        }),
      ]);
      const both = yield* conversationOf("Work list");
      const workOnly = yield* conversationOf("Work only");

      expect(yield* client.counts()).toEqual({
        unread: 3,
        tags: [
          {
            name: "Work",
            unread: 2,
            open: 2,
            senders: [
              { name: "Ada", address: "ada@x.example" },
              { name: "List bot", address: "bot@lists.example" },
            ],
          },
          {
            name: "Lists",
            unread: 1,
            open: 1,
            senders: [{ name: "List bot", address: "bot@lists.example" }],
          },
        ],
        untagged: { unread: 1, open: 1, senders: [{ name: "Bo", address: "bo@x.example" }] },
        cleared: 0,
      });

      expect(
        (yield* listed(work)).map(({ id, tags, participants }) => [id, tags, participants]),
      ).toEqual([
        [workOnly, ["Work"], 2],
        [both, ["Lists", "Work"], 1],
      ]);

      yield* client.read({ params: { id: workOnly }, payload: { seq: 1_000_000 } });
      const afterRead = yield* client.counts();
      expect(afterRead.unread).toBe(2);
      expect(afterRead.tags[0]).toMatchObject({ name: "Work", unread: 1, open: 2 });
    }).pipe(Effect.scoped),
  );

  it.live("unknown tags and conversations are 404, clearing the cleared view is 400", () =>
    Effect.gen(function* () {
      const { client, port } = yield* start;
      for (const name of ["Nope", "Untagged"]) {
        const view: View = { _tag: "Tag", name };
        expect((yield* Effect.flip(client.conversations({ query: { view } })))._tag).toBe(
          "NotFound",
        );
      }
      const clearUnknown = client.clear({
        payload: { view: { _tag: "Tag", name: "Nope" }, seq: 1 },
      });
      expect((yield* Effect.flip(clearUnknown))._tag).toBe("NotFound");
      for (const request of [
        client.read({ params: { id: 9999 }, payload: { seq: 1 } }),
        client.unread({ params: { id: 9999 }, payload: {} }),
        client.done({ params: { id: 9999 }, payload: { seq: 1 } }),
        client.mute({ params: { id: 9999 } }),
        client.restore({ params: { id: 9999 } }),
      ]) {
        expect((yield* Effect.flip(request))._tag).toBe("NotFound");
      }

      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${port}/clear`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ view: "cleared", seq: 1 }),
        }),
      );
      expect(response.status).toBe(400);
    }).pipe(Effect.scoped),
  );
});
