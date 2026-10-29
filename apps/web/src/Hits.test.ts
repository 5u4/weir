import { termPattern } from "@weir/daemon/Match";
import { describe, expect, it } from "vitest";
import { closedUi, type Detail, type Digest, type ItemSummary, topicKey } from "./Blocks.ts";
import { type Hit, hits, reveal } from "./Hits.ts";

const rachel = { name: "Rachel Gomez", address: "rachel.gomez@northwind.example" };
const ben = { name: "Ben Foster", address: "ben.foster@example.com" };
const lisa = { name: "Lisa Chen", address: "lisa.chen@northwind.example" };
const daniel = { name: "", address: "dan.ellis@mail.example" };

const item = (seq: number, from: ItemSummary["from"], body_new: string): ItemSummary => ({
  seq,
  occurred_at: `2026-10-20T09:${String(seq).padStart(2, "0")}:00.000Z`,
  from,
  from_me: false,
  title: null,
  body_new,
});

const digest = (
  id: number,
  from_seq: number,
  to_seq: number,
  headline: string,
  topics: ReadonlyArray<{ title: string; body: string; seqs: ReadonlyArray<number> }>,
): Digest => ({
  id,
  conversation_id: 1,
  from_seq,
  to_seq,
  headline,
  topics: topics.map((topic) => ({ ...topic, state: "open" })),
  trigger: "auto",
  ai_profile: "fake-ai",
  created_at: "2026-10-25T16:00:00.000Z",
});

const detail = (
  items: ReadonlyArray<ItemSummary>,
  digests: ReadonlyArray<Digest> = [],
): Detail => ({
  id: 1,
  source: "gmail",
  title: "Northwind migration: cutover plan and UAT sign-off",
  first_at: items[0]?.occurred_at ?? "",
  last_at: items.at(-1)?.occurred_at ?? "",
  tags: [],
  open: null,
  state: { seen_seq: 0, cleared_seq: 0, muted: false, state: "unread" },
  items,
  digests,
  digest: { backlog: null, earlier: null, now: null, last_failure: null },
});

const northwind = detail(
  [
    item(1, rachel, "Change order CO-0147 attached. Lisa signed it this morning."),
    item(2, ben, "Approved, $1,800 from the migration budget line."),
    item(4, rachel, "I ran the test migration on your Oct 10 snapshot."),
    item(10, ben, "Robin here, nothing to add."),
    item(18, rachel, "Re-ran the migration on the Oct 20 snapshot."),
    item(21, ben, "Lisa wants the dedupe rule decided by Oct 23."),
    item(25, lisa, "Signed."),
    item(30, ben, "Go-live is Monday."),
  ],
  [
    digest(7, 10, 25, "CO-0147 signed; 37 duplicate records need a decision", [
      {
        title: "UAT and cutover",
        body: "Lisa signed CO-0147. UAT sign-off still Oct 24.",
        seqs: [10, 18, 25],
      },
      { title: "Duplicates", body: "Merge or relax the unique rule.", seqs: [21] },
    ]),
  ],
);

const momsBirthday = detail([
  item(29, daniel, "Hey Robin,\n\nI finally worked out Mom's 60th: lunch on Dec 7."),
]);

const trailPacks = detail([item(24, ben, "# 30% off trail packs, this weekend only")]);

const ledger = detail([
  item(23, ben, "Idempotency keys are not enough. The backfill (PR #4818) taught us that."),
  item(26, ben, "Unrelated follow-up."),
]);

const found = (of: Detail, query: string) => hits(of, termPattern(query));

const describeHit = (hit: Hit) =>
  hit._tag === "Item"
    ? `item ${hit.seq} ${hit.field}`
    : hit._tag === "Topic"
      ? `topic ${hit.key}`
      : `headline ${hit.digest}`;

describe("hits", () => {
  it.each([
    ["migrat", northwind, ["item 2 body", "item 4 body", "item 18 body"]],
    ["MIGRAT", northwind, ["item 2 body", "item 4 body", "item 18 body"]],
    ["northwind", northwind, ["item 1 from", "item 4 from", "item 18 from", "item 25 from"]],
    ["lisa", northwind, ["item 1 body", "topic 7:0", "item 25 from", "item 21 body"]],
    ["60", momsBirthday, ["item 29 body"]],
    ["60", trailPacks, []],
    ["idempotency backfill", ledger, ["item 23 body"]],
    ["(PR", ledger, ["item 23 body"]],
    ["dan.ellis", momsBirthday, ["item 29 from"]],
  ] as const)("%s finds its targets in document order", (query, of, expected) => {
    expect(found(of, query).map(describeHit)).toEqual(expected);
  });

  it("counts a two-character term like any other", () => {
    expect(found(momsBirthday, "60")).toHaveLength(1);
    expect(found(trailPacks, "30")).toEqual([{ _tag: "Item", seq: 24, field: "body" }]);
  });

  it("a digest topic that matches is its own hit, before the originals it covers", () => {
    expect(found(northwind, "UAT").map(describeHit)).toEqual(["topic 7:0"]);
    expect(found(northwind, "signed").map(describeHit)).toEqual([
      "item 1 body",
      "headline 7",
      "topic 7:0",
      "item 25 body",
    ]);
  });

  it("matches the sender as name <address>, the text the daemon searches", () => {
    expect(found(northwind, "Gomez").map(describeHit)).toEqual([
      "item 1 from",
      "item 4 from",
      "item 18 from",
    ]);
    expect(found(northwind, "<rachel.gomez@").map(describeHit)).toEqual([
      "item 1 from",
      "item 4 from",
      "item 18 from",
    ]);
  });

  it("a matching headline is one hit for its card", () => {
    expect(found(northwind, "duplicate").map(describeHit)).toEqual(["headline 7", "topic 7:1"]);
  });

  it("does not count a match only in the source or the title", () => {
    expect(found(northwind, "gmail")).toEqual([]);
    expect(found(northwind, "sign-off")).toEqual([
      { _tag: "Topic", key: topicKey(northwind.digests[0] as Digest, 0) },
    ]);
    expect(found(northwind, "cutover plan")).toEqual([
      { _tag: "Topic", key: topicKey(northwind.digests[0] as Digest, 0) },
    ]);
  });

  it("finds nothing without a text term", () => {
    expect(hits(northwind, termPattern(""))).toEqual([]);
    expect(hits(northwind, null)).toEqual([]);
  });
});

describe("reveal", () => {
  const [first] = northwind.digests as [Digest];

  it("opens the card and only the topic that cites a covered original", () => {
    const shown = reveal(closedUi, northwind, { _tag: "Item", seq: 21, field: "body" });
    expect(shown.shapes.get(first.id)).toBe("card");
    expect([...shown.originals]).toEqual([topicKey(first, 1)]);
  });

  it("keeps originals the reader already opened", () => {
    const opened = { ...closedUi, originals: new Set([topicKey(first, 0)]) };
    const shown = reveal(opened, northwind, { _tag: "Item", seq: 21, field: "body" });
    expect([...shown.originals]).toEqual([topicKey(first, 0), topicKey(first, 1)]);
  });

  it("opens the card for a topic or headline hit without unfolding originals", () => {
    for (const hit of [
      { _tag: "Topic", key: topicKey(first, 0) },
      { _tag: "Headline", digest: first.id },
    ] as const) {
      const shown = reveal({ ...closedUi, shapes: new Map([[first.id, "row"]]) }, northwind, hit);
      expect(shown.shapes.get(first.id)).toBe("card");
      expect(shown.originals.size).toBe(0);
    }
  });

  it("leaves the reader as it is for an original outside any digest", () => {
    expect(reveal(closedUi, northwind, { _tag: "Item", seq: 2, field: "body" })).toBe(closedUi);
  });
});
