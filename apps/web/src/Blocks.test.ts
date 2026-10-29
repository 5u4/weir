import { describe, expect, it } from "vitest";
import {
  type Block,
  closedUi,
  type Detail,
  type Digest,
  type ItemSummary,
  participants,
  reader,
  span,
  topicKey,
} from "./Blocks.ts";

const ada = { name: "Ada Lovelace", address: "ada@example.com" };
const ben = { name: "Ben Foster", address: "ben@example.com" };
const robin = { name: "Robin Ellis", address: "robin@example.com" };

const item = (seq: number, minute: number, from = ada, from_me = false): ItemSummary => ({
  seq,
  occurred_at: `2026-10-20T09:${String(minute).padStart(2, "0")}:00.000Z`,
  from,
  from_me,
  title: null,
  body_new: `message ${seq}`,
  stream: "robin.ellis@example.com",
});

const digest = (id: number, from_seq: number, to_seq: number, seqs = [from_seq]): Digest => ({
  id,
  conversation_id: 1,
  from_seq,
  to_seq,
  headline: `digest ${id}`,
  topics: [{ title: "topic", state: "open", body: "body", seqs }],
  trigger: "auto",
  ai_profile: "fake-ai",
  created_at: "2026-10-25T16:00:00.000Z",
});

const detail = (
  items: ReadonlyArray<ItemSummary>,
  digests: ReadonlyArray<Digest> = [],
  earlier: Detail["digest"]["earlier"] = null,
): Detail => ({
  id: 1,
  source: "gmail",
  title: "Northwind",
  first_at: items[0]?.occurred_at ?? "",
  last_at: items.at(-1)?.occurred_at ?? "",
  tags: [],
  open: null,
  state: { seen_seq: 0, cleared_seq: 0, muted: false, state: "unread" },
  items,
  digests,
  digest: { backlog: null, earlier, now: null, last_failure: null },
});

const shape = (blocks: ReadonlyArray<Block>) =>
  blocks.map((block) => {
    switch (block._tag) {
      case "Marker":
        return `${block.kind}(${block.newCount})`;
      case "DigestCard":
      case "DigestRow":
        return `${block._tag}(${block.digest.id})`;
      case "EarlierFold":
        return `EarlierFold(${block.digests.map(({ id }) => id).join(",")})`;
      case "GapBar":
        return `GapBar(${block.gap?.before_digest ?? "-"}, ${block.run_items})`;
      case "Tail":
        return `Tail(${block.items.length})`;
      case "Skeleton":
        return `Skeleton(${block.items})`;
      case "Day":
        return `Day(${block.at})`;
      default:
        return `${block.me ? "me" : block.from.name}[${block.items.map(({ seq }) => seq).join(",")}]`;
    }
  });

describe("reader blocks", () => {
  const northwind = detail(
    [item(1, 0), item(2, 1, ben), item(10, 30, robin, true), item(11, 31), item(12, 32)],
    [digest(1, 10, 11, [10, 11])],
    [{ before_digest: 1, from_seq: 1, to_seq: 2, items: 2, run_items: 2 }],
  );

  it("an unread digest is a card with Last read above it, after the gap bar", () => {
    expect(shape(reader(northwind, 2, closedUi, null))).toEqual([
      "Ada Lovelace[1]",
      "Ben Foster[2]",
      "GapBar(1, 2)",
      "last-read(3)",
      "DigestCard(1)",
      "Tail(1)",
      "Ada Lovelace[12]",
    ]);
  });

  it("a digest read when the conversation opened is a row and Last read moves into the tail", () => {
    expect(shape(reader(northwind, 11, closedUi, null))).toEqual([
      "Ada Lovelace[1]",
      "Ben Foster[2]",
      "GapBar(1, 2)",
      "DigestRow(1)",
      "Tail(1)",
      "last-read(1)",
      "Ada Lovelace[12]",
    ]);
  });

  it("the session shape overrides card or row and keeps Last read above a collapsed card", () => {
    const collapsed = { ...closedUi, shapes: new Map([[1, "row" as const]]) };
    expect(shape(reader(northwind, 2, collapsed, null))).toContain("DigestRow(1)");
    expect(shape(reader(northwind, 2, collapsed, null)).slice(3, 5)).toEqual([
      "last-read(3)",
      "DigestRow(1)",
    ]);
    const expanded = { ...closedUi, shapes: new Map([[1, "card" as const]]) };
    expect(shape(reader(northwind, 12, expanded, null))).toContain("DigestCard(1)");
  });

  it("everything read leaves no marker, nothing read says All new from here at the top", () => {
    expect(shape(reader(northwind, 12, closedUi, null))).not.toContainEqual(
      expect.stringMatching(/last-read|all-new/),
    );
    expect(shape(reader(northwind, 0, closedUi, null))[0]).toBe("all-new(5)");
  });

  it("the gap bar counts the run from digest.earlier and falls back to the run itself", () => {
    expect(
      shape(
        reader(
          { ...northwind, digest: { ...northwind.digest, earlier: null } },
          12,
          closedUi,
          null,
        ),
      ),
    ).toContain("GapBar(-, 2)");
  });

  it("groups bubbles by sender and by a pause of five minutes, and mirrors my own", () => {
    const chat = detail([
      item(1, 0),
      item(2, 4),
      item(3, 9),
      item(4, 10, robin, true),
      item(5, 11, robin, true),
      item(6, 12, ben),
    ]);
    expect(shape(reader(chat, 6, closedUi, null))).toEqual([
      "Tail(6)",
      "Ada Lovelace[1,2]",
      "Ada Lovelace[3]",
      "me[4,5]",
      "Ben Foster[6]",
    ]);
  });

  it("Last read splits a group at the first new message", () => {
    const chat = detail([item(1, 0), item(2, 1), item(3, 2)]);
    expect(shape(reader(chat, 1, closedUi, null))).toEqual([
      "Tail(3)",
      "Ada Lovelace[1]",
      "last-read(2)",
      "Ada Lovelace[2,3]",
    ]);
  });

  it.each([
    ["all unread", 0, ["all-new(6)", "Skeleton(6)", "Ada Lovelace[1,2,3,4,5,6]"]],
    ["crossing Last read", 2, ["last-read(4)", "Skeleton(6)", "Ada Lovelace[1,2,3,4,5,6]"]],
    ["all read", 6, ["Skeleton(6)", "Ada Lovelace[1,2,3,4,5,6]"]],
  ])("a running range %s puts the marker before its skeleton", (_, seen, expected) => {
    const chat = detail([1, 2, 3, 4, 5, 6].map((seq) => item(seq, seq)));
    expect(shape(reader(chat, seen, closedUi, { from: 1, to: 6 }))).toEqual(expected);
  });

  it("more than four read rows fold the leading ones into earlier digests", () => {
    const items = [1, 2, 3, 4, 5, 6].map((seq) => item(seq, seq * 5));
    const digests = items.map(({ seq }) => digest(seq, seq, seq));
    const many = detail(items, digests);
    expect(shape(reader(many, 6, closedUi, null))).toEqual([
      "EarlierFold(1,2)",
      "DigestRow(3)",
      "DigestRow(4)",
      "DigestRow(5)",
      "DigestRow(6)",
    ]);
    expect(shape(reader(many, 6, { ...closedUi, earlier: true }, null))).toHaveLength(6);
    expect(shape(reader(many, 4, closedUi, null))).toEqual([
      "DigestRow(1)",
      "DigestRow(2)",
      "DigestRow(3)",
      "DigestRow(4)",
      "last-read(2)",
      "DigestCard(5)",
      "DigestCard(6)",
    ]);
  });

  it("a topic's originals group under it only while unfolded", () => {
    const closed = reader(northwind, 2, closedUi, null).find(
      (block) => block._tag === "DigestCard",
    );
    expect(closed?._tag === "DigestCard" && closed.topics[0]).toMatchObject({
      open: false,
      groups: [],
    });
    const key = topicKey(northwind.digests[0] as Digest, 0);
    const open = reader(northwind, 2, { ...closedUi, originals: new Set([key]) }, null).find(
      (block) => block._tag === "DigestCard",
    );
    expect(open?._tag === "DigestCard" && shape(open.topics[0]?.groups ?? [])).toEqual([
      "me[10]",
      "Ada Lovelace[11]",
    ]);
  });

  describe("day separators", () => {
    const nextDay = "2026-10-13T12:00:00.000Z";
    const days = [
      { ...item(1, 0), occurred_at: "2026-10-12T12:00:00.000Z" },
      { ...item(2, 0), occurred_at: nextDay },
      { ...item(3, 0), occurred_at: "2026-10-13T12:01:00.000Z" },
    ];

    it("a new day splits one sender's run under exactly one separator", () => {
      expect(shape(reader(detail(days), 3, closedUi, null))).toEqual([
        "Tail(3)",
        "Ada Lovelace[1]",
        `Day(${nextDay})`,
        "Ada Lovelace[2,3]",
      ]);
    });

    it("the separator comes before Last read on the same message", () => {
      expect(shape(reader(detail(days), 1, closedUi, null))).toEqual([
        "Tail(3)",
        "Ada Lovelace[1]",
        `Day(${nextDay})`,
        "last-read(2)",
        "Ada Lovelace[2,3]",
      ]);
    });

    it("a topic's unfolded originals get separators too", () => {
      const digested = detail(days, [digest(1, 1, 3, [1, 2, 3])]);
      const key = topicKey(digested.digests[0] as Digest, 0);
      const card = reader(digested, 0, { ...closedUi, originals: new Set([key]) }, null).find(
        (block) => block._tag === "DigestCard",
      );
      expect(card?._tag === "DigestCard" && shape(card.topics[0]?.groups ?? [])).toEqual([
        "Ada Lovelace[1]",
        `Day(${nextDay})`,
        "Ada Lovelace[2,3]",
      ]);
    });
  });

  it("counts me once among the participants", () => {
    expect(participants(northwind)).toBe(3);
  });
});

describe("time span", () => {
  it.each([
    ["no items", [], null],
    [
      "one item",
      [item(1, 5)],
      { first: "2026-10-20T09:05:00.000Z", last: "2026-10-20T09:05:00.000Z" },
    ],
    [
      "items in time order",
      [item(1, 5), item(2, 9)],
      { first: "2026-10-20T09:05:00.000Z", last: "2026-10-20T09:09:00.000Z" },
    ],
    [
      "a later seq that happened earlier",
      [item(1, 30), item(2, 5), item(3, 12)],
      { first: "2026-10-20T09:05:00.000Z", last: "2026-10-20T09:30:00.000Z" },
    ],
  ])("%s", (_, items, expected) => {
    expect(span(items)).toEqual(expected);
  });
});
