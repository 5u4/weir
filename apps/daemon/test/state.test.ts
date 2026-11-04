import { describe, expect, it } from "@effect/vitest";
import type { RawItem } from "@weir/contract/Source";
import * as Database from "@weir/store/Database";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
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
  return { client, port, home, listed, deliver, conversationOf, seqsOf };
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
      expect(detail.state).toEqual({
        seen_seq: s2,
        cleared_seq: 0,
        muted: false,
        state: "read",
        plan: { _tag: "None" },
        planned_at: null,
        due: null,
      });
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

      const { now, ...counts } = yield* client.counts();
      expect(now.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(counts).toEqual({
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
        planned: { count: 0, dues: [] },
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

  it.live("senders take each unread conversation's latest sender who is not me", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf } = yield* start;
      yield* deliver([
        item("i1", "busy", 1, { title: "Work busy", from: { name: "A", address: "a@x.example" } }),
        item("i2", "busy", 2, { from: { name: "B", address: "b@x.example" } }),
        item("i3", "busy", 3, { from: { name: "C", address: "c@x.example" } }),
        item("i4", "quiet", 4, {
          title: "Work quiet",
          from: { name: "D", address: "d@x.example" },
        }),
      ]);
      const quiet = yield* conversationOf("Work quiet");
      yield* client.read({ params: { id: quiet }, payload: { seq: 1_000_000 } });
      yield* deliver([item("i5", "quiet", 5, { from: { name: "Me", address: "me@example.com" } })]);

      const counts = yield* client.counts();
      expect(counts.tags.find(({ name }) => name === "Work")).toMatchObject({
        unread: 2,
        senders: [
          { name: "D", address: "d@x.example" },
          { name: "C", address: "c@x.example" },
        ],
      });
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

describe("search", () => {
  it.live("returns rows with up to three marked hit lines, newest first", () =>
    Effect.gen(function* () {
      const { client, deliver, conversationOf, seqsOf } = yield* start;
      const padding = "lorem ipsum dolor sit amet ".repeat(6);
      yield* deliver([
        item("g1", "plan", 1, { title: "Plan", bodyNew: "code freeze starts Monday" }),
        item("g2", "plan", 2, {
          bodyNew: "ok",
          from: { name: "Freeze Bot", address: "bot@x.example" },
        }),
        item("g3", "plan", 3, { bodyNew: `${padding}the freeze\nmoved ${padding}` }),
        item("g4", "plan", 4, { bodyNew: "FREEZE confirmed" }),
        item("g5", "other", 5, { title: "Other", bodyNew: "freeze too" }),
      ]);
      const plan = yield* conversationOf("Plan");
      const other = yield* conversationOf("Other");
      const [, s2, s3, s4] = yield* seqsOf(plan);
      yield* client.done({ params: { id: plan }, payload: { seq: 1_000_000 } });
      yield* client.mute({ params: { id: other } });

      const { conversations } = yield* client.search({ query: { q: "freeze" } });
      const planHit = conversations.find(({ id }) => id === plan);
      const otherHit = conversations.find(({ id }) => id === other);
      expect(planHit?.state).toBe("done");
      expect(otherHit?.state).toBe("muted");
      expect(otherHit?.hits).toEqual([
        {
          field: "body",
          seq: expect.any(Number),
          digest_id: null,
          title: null,
          text: [
            { text: "freeze", mark: true },
            { text: " too", mark: false },
          ],
        },
      ]);

      const hits = planHit?.hits ?? [];
      expect(hits.map(({ field, seq }) => [field, seq])).toEqual([
        ["body", s4],
        ["body", s3],
        ["from", s2],
      ]);
      expect(hits[0]?.text).toEqual([
        { text: "FREEZE", mark: true },
        { text: " confirmed", mark: false },
      ]);
      const snippet = hits[1]?.text ?? [];
      const snippetText = snippet.map(({ text }) => text).join("");
      expect(snippetText.startsWith("…") && snippetText.endsWith("…")).toBe(true);
      expect(snippetText.length).toBeLessThanOrEqual(122);
      expect(snippetText).toContain("the freeze moved");
      expect(snippet.filter(({ mark }) => mark).map(({ text }) => text)).toEqual(["freeze"]);
      expect(hits[2]?.text).toEqual([
        { text: "Freeze", mark: true },
        { text: " Bot <bot@x.example>", mark: false },
      ]);

      const empty = yield* client.search({ query: { q: "" } });
      expect(empty.conversations.every(({ hits }) => hits.length === 0)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("digest topics and headlines produce hit lines", () =>
    Effect.gen(function* () {
      const { client, home, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("j1", "rollout", 1, { title: "Rollout", bodyNew: "kickoff" }),
        item("j2", "rollout", 2, { bodyNew: "canary looks good" }),
        item("j3", "rollout", 3, { bodyNew: "thanks" }),
      ]);
      const id = yield* conversationOf("Rollout");
      const [s1, s2, s3] = yield* seqsOf(id);
      if (s1 === undefined || s2 === undefined || s3 === undefined) {
        throw new Error("expected three items");
      }
      const digestId = 7;
      const topics = [
        { title: "Canary plan", state: "open", body: "Ship the canary Friday", seqs: [s1, s2] },
        { title: "Wrap-up", state: "fyi", body: "Thanked the team", seqs: [s3] },
        { title: "Canary metrics", state: "fyi", body: "Dashboards", seqs: [s3 + 1000] },
      ];
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO digest
          (id, conversation_id, from_seq, to_seq, headline, topics, "trigger", ai_profile, created_at)
          VALUES (${digestId}, ${id}, ${s1}, ${s3}, 'Canary rollout approved',
            ${JSON.stringify(topics)}, 'manual', 'test', '2026-10-28T10:00:00.000Z')`;
        yield* sql`INSERT INTO search_fts (rowid, text, conversation_id, item_seq, digest_id)
          VALUES (${-digestId}, 'Canary rollout approved', ${id}, NULL, ${digestId})`;
      }).pipe(Effect.provide(Database.layer(home.db)));

      const { conversations } = yield* client.search({ query: { q: "canary" } });
      const topic = {
        field: "topic",
        digest_id: digestId,
        title: [
          { text: "Canary", mark: true },
          { text: " plan", mark: false },
        ],
        text: [
          { text: "Ship the ", mark: false },
          { text: "canary", mark: true },
          { text: " Friday", mark: false },
        ],
      };
      expect(conversations.find((conversation) => conversation.id === id)?.hits).toEqual([
        { ...topic, seq: s2 },
        {
          field: "topic",
          seq: null,
          digest_id: digestId,
          title: [
            { text: "Canary", mark: true },
            { text: " metrics", mark: false },
          ],
          text: [{ text: "Dashboards", mark: false }],
        },
        {
          field: "headline",
          seq: null,
          digest_id: digestId,
          title: null,
          text: [
            { text: "Canary", mark: true },
            { text: " rollout approved", mark: false },
          ],
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("a newer matching message outranks topics from an older digest", () =>
    Effect.gen(function* () {
      const { client, home, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("k1", "launch", 1, { title: "Launch", bodyNew: "kickoff" }),
        item("k2", "launch", 2, { bodyNew: "draft" }),
        item("k3", "launch", 3, { bodyNew: "review" }),
        item("k4", "launch", 4, { bodyNew: "canary rolled back" }),
      ]);
      const id = yield* conversationOf("Launch");
      const [s1, s2, s3, s4] = yield* seqsOf(id);
      if (s1 === undefined || s2 === undefined || s3 === undefined || s4 === undefined) {
        throw new Error("expected four items");
      }
      const topics = [
        { title: "Canary scope", state: "fyi", body: "One region", seqs: [s1] },
        { title: "Canary owner", state: "fyi", body: "Ops", seqs: [s2] },
        { title: "Canary date", state: "open", body: "Friday", seqs: [s3] },
      ];
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO digest
          (id, conversation_id, from_seq, to_seq, headline, topics, "trigger", ai_profile, created_at)
          VALUES (8, ${id}, ${s1}, ${s3}, 'Launch planned', ${JSON.stringify(topics)},
            'manual', 'test', '2026-10-28T10:00:00.000Z')`;
      }).pipe(Effect.provide(Database.layer(home.db)));

      const { conversations } = yield* client.search({ query: { q: "canary" } });
      const hits = conversations.find((conversation) => conversation.id === id)?.hits ?? [];
      expect(hits.map(({ field, seq }) => [field, seq])).toEqual([
        ["body", s4],
        ["topic", s3],
        ["topic", s2],
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("list rows", () => {
  const ann = { name: "Ann Lee", address: "ann@x.example" };
  const bob = { name: "Bob", address: "bob@x.example" };
  const me = { name: "Me", address: "me@example.com" };

  it.live("from is the newest sender who is not me, senders the first two by appearance", () =>
    Effect.gen(function* () {
      const { listed, deliver, conversationOf } = yield* start;
      yield* deliver([
        item("r1", "team", 1, { title: "Team sync", from: ann, bodyNew: "agenda" }),
        item("r2", "team", 2, { from: bob }),
        item("r3", "team", 3, { from: { name: "Ann L", address: "ANN@X.example" } }),
        item("r4", "team", 4, { from: { name: "Cy", address: "cy@x.example" } }),
        item("r5", "team", 5, { from: me, bodyNew: "thanks all" }),
        item("r6", "solo", 6, { title: "Note to self", from: me, bodyNew: "buy milk" }),
      ]);
      const team = yield* conversationOf("Team sync");
      const solo = yield* conversationOf("Note to self");
      const rows = yield* listed(untagged);

      expect(rows.find(({ id }) => id === team)).toMatchObject({
        from: { name: "Cy", address: "cy@x.example" },
        senders: [ann, bob],
        participants: 4,
        preview: "Me: thanks all",
      });
      expect(rows.find(({ id }) => id === solo)).toMatchObject({
        from: me,
        senders: [me],
        participants: 1,
        preview: "Me: buy milk",
      });
    }).pipe(Effect.scoped),
  );

  it.live("from and senders mark the parties that are me in every row producer", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("m1", "mixed", 1, { title: "Mixed plan", from: me }),
        item("m2", "mixed", 2, { from: ann }),
        item("m3", "mine", 3, { title: "Only me", from: me }),
      ]);
      const mixed = yield* conversationOf("Mixed plan");
      const mine = yield* conversationOf("Only me");
      const parties = (row: { readonly from: unknown; readonly senders: unknown } | undefined) => ({
        from: row?.from,
        senders: row?.senders,
      });
      const producers = (id: number) =>
        Effect.gen(function* () {
          const [seq] = yield* seqsOf(id);
          if (seq === undefined) throw new Error("expected an item");
          return [
            parties((yield* listed(untagged)).find((row) => row.id === id)),
            parties(
              (yield* client.search({ query: { q: "" } })).conversations.find(
                (row) => row.id === id,
              ),
            ),
            parties(yield* client.read({ params: { id }, payload: { seq } })),
          ];
        });

      const mixedParties = {
        from: { ...ann, me: false },
        senders: [
          { ...me, me: true },
          { ...ann, me: false },
        ],
      };
      expect(yield* producers(mixed)).toEqual([mixedParties, mixedParties, mixedParties]);
      const mineParties = { from: { ...me, me: true }, senders: [{ ...me, me: true }] };
      expect(yield* producers(mine)).toEqual([mineParties, mineParties, mineParties]);
    }).pipe(Effect.scoped),
  );

  it.live("preview is the digest headline only when the newest digest reaches the last item", () =>
    Effect.gen(function* () {
      const { client, home, listed, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("p1", "spec", 1, { title: "Spec review", from: ann, bodyNew: "draft attached" }),
        item("p2", "spec", 2, { from: bob, bodyNew: "looks fine" }),
        item("p3", "spec", 3, {
          from: ann,
          bodyNew:
            "<p>See **the** [spec](https://x.example/spec) ![diagram](https://x.example/a.png) at https://x.example/raw</p>\n\n> quoted",
        }),
      ]);
      const id = yield* conversationOf("Spec review");
      const [s1, s2, s3] = yield* seqsOf(id);
      if (s1 === undefined || s2 === undefined || s3 === undefined) {
        throw new Error("expected three items");
      }
      const insertDigest = (digestId: number, fromSeq: number, toSeq: number, headline: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const topics = [{ title: "Spec", state: "fyi", body: headline, seqs: [fromSeq] }];
          yield* sql`INSERT INTO digest
            (id, conversation_id, from_seq, to_seq, headline, topics, "trigger", ai_profile, created_at)
            VALUES (${digestId}, ${id}, ${fromSeq}, ${toSeq}, ${headline},
              ${JSON.stringify(topics)}, 'manual', 'test', '2026-10-28T10:00:00.000Z')`;
        }).pipe(Effect.provide(Database.layer(home.db)));
      const previews = Effect.gen(function* () {
        const fromList = (yield* listed(untagged)).find((row) => row.id === id)?.preview;
        const fromSearch = (yield* client.search({ query: { q: "" } })).conversations.find(
          (row) => row.id === id,
        )?.preview;
        const fromWrite = (yield* client.read({ params: { id }, payload: { seq: s1 } })).preview;
        return [fromList, fromSearch, fromWrite];
      });
      const lastMessage =
        "Ann: See **the** [spec](https://x.example/spec) ![diagram](https://x.example/a.png) at https://x.example/raw quoted";

      expect(yield* previews).toEqual([lastMessage, lastMessage, lastMessage]);

      yield* insertDigest(1, s1, s2, "Draft reviewed");
      expect(yield* previews).toEqual([lastMessage, lastMessage, lastMessage]);

      yield* insertDigest(2, s3, s3, "Ann shared the spec");
      const headline = "Ann shared the spec";
      expect(yield* previews).toEqual([headline, headline, headline]);
    }).pipe(Effect.scoped),
  );

  it.live("an HTML email previews its visible words, never its CSS or tags", () =>
    Effect.gen(function* () {
      const { listed, deliver, conversationOf } = yield* start;
      const html = `<html><head><title>Receipt</title><style>.hero{font-size:60px}</style></head><body><table class="hero"><tr><td>Your trip</td><td>is booked</td></tr></table></body></html>`;
      yield* deliver([
        item("h1", "trip", 1, {
          title: "Trip",
          from: ann,
          format: "html",
          body: html,
          bodyNew: html,
        }),
      ]);
      const id = yield* conversationOf("Trip");
      expect((yield* listed(untagged)).find((row) => row.id === id)?.preview).toBe(
        "Ann: Your trip is booked",
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    "an empty body previews as no text, a bare link as its text, long bodies cut at 160 code points",
    () =>
      Effect.gen(function* () {
        const { listed, deliver, conversationOf } = yield* start;
        yield* deliver([
          item("n1", "blank", 1, { title: "Blank", from: ann, bodyNew: "" }),
          item("n2", "link", 2, {
            title: "Link only",
            from: { name: "", address: "zed.q@x.example" },
            bodyNew: "https://x.example/only ![x](https://x.example/x.png)",
          }),
          item("n3", "long", 3, { title: "Long", from: bob, bodyNew: "😀".repeat(200) }),
        ]);
        const rows = yield* listed(untagged);
        const previewOf = (title: string) =>
          conversationOf(title).pipe(
            Effect.map((id) => rows.find((row) => row.id === id)?.preview),
          );

        expect(yield* previewOf("Blank")).toBe("Ann: (no text)");
        expect(yield* previewOf("Link only")).toBe("zed.q: https://x.example/only");
        expect(yield* previewOf("Long")).toBe(`Bob: ${"😀".repeat(160)}`);
      }).pipe(Effect.scoped),
  );
});

describe("plan and due", () => {
  const insertDigest = (
    db: string,
    digest: {
      readonly id: number;
      readonly conversationId: number;
      readonly fromSeq: number;
      readonly toSeq: number;
      readonly dues: ReadonlyArray<{ readonly date: string; readonly seq: number }>;
    },
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const topics = [
        { title: "Chatter", state: "fyi", body: "no date here", seqs: [digest.fromSeq] },
        ...digest.dues.map((due) => ({
          title: `Due ${due.date}`,
          state: "open",
          body: "needs a reply",
          seqs: [due.seq],
          due,
        })),
      ];
      yield* sql`INSERT INTO digest
        (id, conversation_id, from_seq, to_seq, headline, topics, "trigger", ai_profile, created_at)
        VALUES (${digest.id}, ${digest.conversationId}, ${digest.fromSeq}, ${digest.toSeq},
          'Headline', ${JSON.stringify(topics)}, 'manual', 'test', '2026-10-28T10:00:00.000Z')`;
    }).pipe(Effect.provide(Database.layer(db)));

  it.live("each plan kind moves the conversation out of its view and into Cleared", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf } = yield* start;
      yield* deliver([item("q1", "t1", 1, { title: "Work quarterly" })]);
      const id = yield* conversationOf("Work quarterly");

      const tray = yield* client.plan({ params: { id }, payload: { plan: { _tag: "Tray" } } });
      expect(tray).toMatchObject({ state: "planned", plan: { _tag: "Tray" } });
      expect(tray.planned_at).toEqual(expect.any(String));
      expect(ids(yield* listed(work))).toEqual([]);
      expect(states(yield* listed(cleared))).toEqual([[id, "planned"]]);
      const counts = yield* client.counts();
      expect(counts).toMatchObject({ unread: 0, cleared: 1, planned: { count: 1, dues: [] } });
      expect(counts.tags.find(({ name }) => name === "Work")).toMatchObject({ unread: 0, open: 0 });

      const day = { _tag: "Day", date: "2026-10-29" } as const;
      expect((yield* client.plan({ params: { id }, payload: { plan: day } })).plan).toEqual(day);

      const slot = { _tag: "Slot", date: "2026-10-29", start: 900, minutes: 30 } as const;
      expect((yield* client.plan({ params: { id }, payload: { plan: slot } })).plan).toEqual(slot);
      expect((yield* client.conversation({ params: { id } })).state).toMatchObject({
        state: "planned",
        plan: slot,
      });
      expect((yield* client.search({ query: { q: "quarterly" } })).conversations).toMatchObject([
        { id, state: "planned", plan: slot },
      ]);

      const unplanned = yield* client.plan({ params: { id }, payload: { plan: { _tag: "None" } } });
      expect(unplanned).toMatchObject({
        state: "unread",
        plan: { _tag: "None" },
        planned_at: null,
      });
      expect(ids(yield* listed(work))).toEqual([id]);
    }).pipe(Effect.scoped),
  );

  it.live("a planned conversation that receives a new item stays planned with one new", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([item("r1", "t1", 1, { title: "Work offsite" })]);
      const id = yield* conversationOf("Work offsite");
      const [s1] = yield* seqsOf(id);
      if (s1 === undefined) throw new Error("expected one item");
      yield* client.read({ params: { id }, payload: { seq: s1 } });
      yield* client.plan({ params: { id }, payload: { plan: { _tag: "Tray" } } });

      yield* deliver([item("r2", "t1", 2, { title: "Re: Work offsite" })]);
      expect(ids(yield* listed(work))).toEqual([]);
      const [row] = yield* listed(cleared);
      expect(row).toMatchObject({ id, state: "planned", new: 1, plan: { _tag: "Tray" } });
      expect((yield* client.counts()).unread).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live("done and back to inbox both clear the plan", () =>
    Effect.gen(function* () {
      const { client, listed, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([item("s1", "t1", 1, { title: "Work invoice" })]);
      const id = yield* conversationOf("Work invoice");
      const [last] = yield* seqsOf(id);
      if (last === undefined) throw new Error("expected one item");
      const day = { _tag: "Day", date: "2026-10-26" } as const;

      yield* client.plan({ params: { id }, payload: { plan: day } });
      const done = yield* client.done({ params: { id }, payload: { seq: last } });
      expect(done).toMatchObject({ state: "done", plan: { _tag: "None" }, planned_at: null });
      expect((yield* client.counts()).planned).toEqual({ count: 0, dues: [] });

      yield* client.plan({ params: { id }, payload: { plan: day } });
      const restored = yield* client.restore({ params: { id } });
      expect(restored).toMatchObject({ state: "read", plan: { _tag: "None" }, planned_at: null });
      expect(ids(yield* listed(work))).toEqual([id]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a user due beats the AI due, cleared hides it, and the latest digest's AI due wins",
    () =>
      Effect.gen(function* () {
        const { client, home, deliver, conversationOf, seqsOf } = yield* start;
        yield* deliver([
          item("u1", "t1", 1, { title: "Work contract" }),
          item("u2", "t1", 2, {}),
          item("u3", "t1", 3, {}),
        ]);
        const id = yield* conversationOf("Work contract");
        const [s1, s2, s3] = yield* seqsOf(id);
        if (s1 === undefined || s2 === undefined || s3 === undefined) {
          throw new Error("expected three items");
        }
        const dueOf = client
          .conversation({ params: { id } })
          .pipe(Effect.map(({ state }) => state.due));
        expect(yield* dueOf).toBeNull();

        yield* insertDigest(home.db, {
          id: 1,
          conversationId: id,
          fromSeq: s1,
          toSeq: s2,
          dues: [
            { date: "2026-10-30", seq: s1 },
            { date: "2026-10-23", seq: s2 },
          ],
        });
        const earliest = { date: "2026-10-23", by: { _tag: "Ai", seq: s2 } };
        expect(yield* dueOf).toEqual(earliest);

        yield* insertDigest(home.db, {
          id: 2,
          conversationId: id,
          fromSeq: s3,
          toSeq: s3,
          dues: [{ date: "2026-11-02", seq: s3 }],
        });
        const latest = { date: "2026-11-02", by: { _tag: "Ai", seq: s3 } };
        expect(yield* dueOf).toEqual(latest);

        const user = yield* client.due({
          params: { id },
          payload: { due: { _tag: "Date", date: "2026-11-12" } },
        });
        expect(user.due).toEqual({ date: "2026-11-12", by: { _tag: "User" } });

        const hidden = yield* client.due({ params: { id }, payload: { due: { _tag: "Cleared" } } });
        expect(hidden.due).toBeNull();
        expect(yield* dueOf).toBeNull();

        const reset = yield* client.due({ params: { id }, payload: { due: { _tag: "None" } } });
        expect(reset.due).toEqual(latest);
      }).pipe(Effect.scoped),
  );

  it.live("counts report planned dues and the daemon's local date and minute", () => {
    const fixedMillis = Date.parse("2026-10-25T09:00:00-07:00");
    const live = Clock.Clock.defaultValue();
    const fixed: Clock.Clock = {
      currentTimeMillisUnsafe: () => fixedMillis,
      currentTimeMillis: Effect.sync(() => fixedMillis),
      currentTimeNanosUnsafe: () => BigInt(fixedMillis) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(fixedMillis) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) => live.sleep(duration),
    };
    return Effect.gen(function* () {
      const { client, home, deliver, conversationOf, seqsOf } = yield* start;
      yield* deliver([
        item("v1", "northwind", 1, { title: "Northwind renewal" }),
        item("v2", "party", 2, { title: "Party" }),
        item("v3", "tray", 3, { title: "Someday" }),
      ]);
      const northwind = yield* conversationOf("Northwind renewal");
      const party = yield* conversationOf("Party");
      const someday = yield* conversationOf("Someday");
      const [northwindSeq] = yield* seqsOf(northwind);
      if (northwindSeq === undefined) throw new Error("expected one item");
      yield* insertDigest(home.db, {
        id: 1,
        conversationId: northwind,
        fromSeq: northwindSeq,
        toSeq: northwindSeq,
        dues: [{ date: "2026-10-23", seq: northwindSeq }],
      });
      yield* client.due({
        params: { id: party },
        payload: { due: { _tag: "Date", date: "2026-10-30" } },
      });

      const before = yield* client.counts();
      expect(before.planned).toEqual({ count: 0, dues: [] });
      expect(before.now).toEqual({ date: "2026-10-25", minute: 540 });

      const planned = yield* client.plan({
        params: { id: northwind },
        payload: { plan: { _tag: "Tray" } },
      });
      expect(planned.planned_at).toBe("2026-10-25T16:00:00.000Z");
      yield* client.plan({
        params: { id: party },
        payload: { plan: { _tag: "Day", date: "2026-10-24" } },
      });
      yield* client.plan({ params: { id: someday }, payload: { plan: { _tag: "Tray" } } });
      expect((yield* client.counts()).planned).toEqual({
        count: 3,
        dues: ["2026-10-23", "2026-10-30"],
      });
    }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, fixed));
  });
});
