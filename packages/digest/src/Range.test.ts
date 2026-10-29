import { describe, expect, it } from "@effect/vitest";
import type { ContextEntry, InputItem } from "@weir/contract/Digest";
import { DigestId, Seq } from "@weir/store/Rows";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { context, type DigestText } from "./Prompt.ts";
import {
  autoRange,
  backlog,
  chunks,
  gaps,
  type ItemLite,
  manualRange,
  type Span,
} from "./Range.ts";

const since = DateTime.makeUnsafe("2026-10-28T09:00:00Z");

const item = (seq: number, chars: number, occurredAt = "2026-10-28T09:00:00Z"): ItemLite => ({
  seq: Seq.make(seq),
  occurredAt: DateTime.makeUnsafe(occurredAt),
  chars,
});

const span = (id: number, fromSeq: number, toSeq: number): Span => ({
  id: DigestId.make(id),
  fromSeq: Seq.make(fromSeq),
  toSeq: Seq.make(toSeq),
});

const range = (fromSeq: number, toSeq: number) => ({
  fromSeq: Seq.make(fromSeq),
  toSeq: Seq.make(toSeq),
});

const conversation = (chars: readonly [number, number, number, number, number]) =>
  [3, 7, 12, 20, 31].map((seq, index) => item(seq, chars[index] ?? 0));

const maxInput = 24000;

describe("autoRange", () => {
  const items = (lastChars: number) => [
    item(3, 100, "2026-10-28T08:00:00Z"),
    item(7, 400, "2026-10-28T09:00:00Z"),
    item(12, 300, "2026-10-28T09:30:00Z"),
    item(20, 200, "2026-10-28T08:30:00Z"),
    item(31, lastChars, "2026-10-28T10:00:00Z"),
  ];

  it("fires when chars from the first item at or after since reach the threshold", () => {
    expect(autoRange(items(100), [], since, 1000)).toEqual(range(7, 31));
  });

  it("returns null one char below the threshold", () => {
    expect(autoRange(items(99), [], since, 1000)).toBeNull();
  });

  it("skips an old item after the floor as start but counts a later old item", () => {
    expect(backlog(items(100), [], since)).toEqual({ chars: 1000, range: range(7, 31) });
  });

  it("starts after the floor of existing digests", () => {
    const spans = [span(1, 3, 7)];
    expect(backlog(items(100), spans, since)).toEqual({ chars: 600, range: range(12, 31) });
    expect(autoRange(items(100), spans, since, 600)).toEqual(range(12, 31));
    expect(autoRange(items(100), spans, since, 601)).toBeNull();
  });

  it("reports no backlog when nothing after the floor is recent", () => {
    expect(backlog(items(100), [span(1, 3, 31)], since)).toEqual({ chars: 0, range: null });
    expect(backlog([item(3, 5000, "2026-10-28T08:00:00Z")], [], since)).toEqual({
      chars: 0,
      range: null,
    });
  });
});

describe("manualRange", () => {
  const small = conversation([100, 100, 100, 100, 100]);

  it("Now covers everything after the last digest", () => {
    expect(manualRange(small, [], { _tag: "Now" }, maxInput)).toEqual(Result.succeed(range(3, 31)));
    expect(manualRange(small, [span(1, 3, 12)], { _tag: "Now" }, maxInput)).toEqual(
      Result.succeed(range(20, 31)),
    );
  });

  it("Now fails when the last digest reaches the last item", () => {
    expect(manualRange(small, [span(1, 3, 31)], { _tag: "Now" }, maxInput)).toEqual(
      Result.fail("nothing after the last digest"),
    );
  });

  it("From runs to the last item before the next digest", () => {
    expect(
      manualRange(small, [span(1, 20, 31)], { _tag: "From", seq: Seq.make(7) }, maxInput),
    ).toEqual(Result.succeed(range(7, 12)));
  });

  it("From runs to the last item when no digest follows", () => {
    expect(
      manualRange(small, [span(1, 3, 7)], { _tag: "From", seq: Seq.make(12) }, maxInput),
    ).toEqual(Result.succeed(range(12, 31)));
  });

  it("UpTo walks back while the chars stay within maxInput", () => {
    const items = conversation([10000, 9000, 8000, 7000, 6000]);
    expect(manualRange(items, [], { _tag: "UpTo", seq: Seq.make(31) }, maxInput)).toEqual(
      Result.succeed(range(12, 31)),
    );
    expect(manualRange(items, [], { _tag: "UpTo", seq: Seq.make(20) }, maxInput)).toEqual(
      Result.succeed(range(7, 20)),
    );
  });

  it("UpTo stops at the latest earlier digest and ignores later ones", () => {
    expect(
      manualRange(
        small,
        [span(1, 3, 3), span(2, 7, 7), span(3, 31, 31)],
        { _tag: "UpTo", seq: Seq.make(20) },
        maxInput,
      ),
    ).toEqual(Result.succeed(range(12, 20)));
  });

  it("UpTo of an item over maxInput is that item alone", () => {
    const items = conversation([100, 100, 100, 30000, 100]);
    expect(manualRange(items, [], { _tag: "UpTo", seq: Seq.make(20) }, maxInput)).toEqual(
      Result.succeed(range(20, 20)),
    );
  });

  it("rejects a seq outside the conversation bounds", () => {
    expect(manualRange(small, [], { _tag: "From", seq: Seq.make(2) }, maxInput)).toEqual(
      Result.fail("#2 is outside #3-#31"),
    );
    expect(manualRange(small, [], { _tag: "UpTo", seq: Seq.make(40) }, maxInput)).toEqual(
      Result.fail("#40 is outside #3-#31"),
    );
  });

  it("rejects a seq inside the bounds that belongs to another conversation", () => {
    expect(manualRange(small, [], { _tag: "From", seq: Seq.make(10) }, maxInput)).toEqual(
      Result.fail("#10 is not a message in this conversation"),
    );
  });

  it("rejects a seq already in a digest", () => {
    const spans = [span(1, 3, 12)];
    expect(manualRange(small, spans, { _tag: "From", seq: Seq.make(7) }, maxInput)).toEqual(
      Result.fail("#7 is already in a digest"),
    );
    expect(manualRange(small, spans, { _tag: "UpTo", seq: Seq.make(12) }, maxInput)).toEqual(
      Result.fail("#12 is already in a digest"),
    );
  });

  it("Redo returns the digest's exact range", () => {
    expect(
      manualRange(small, [span(1, 7, 12)], { _tag: "Redo", id: DigestId.make(1) }, maxInput),
    ).toEqual(Result.succeed(range(7, 12)));
  });

  it("Redo of an unknown digest fails", () => {
    expect(
      Result.isFailure(
        manualRange(small, [span(1, 7, 12)], { _tag: "Redo", id: DigestId.make(9) }, maxInput),
      ),
    ).toBe(true);
  });
});

describe("gaps", () => {
  const items = (chars: ReadonlyArray<number>) =>
    chars.map((count, index) => item(index + 1, count));
  const gap = (fromSeq: number, toSeq: number, count: number, runItems: number) => ({
    ...range(fromSeq, toSeq),
    items: count,
    runItems,
  });

  it("has one earlier entry per run before a digest, in seq order, and the tail as now", () => {
    const eight = items([100, 100, 100, 100, 100, 100, 100, 100]);
    expect(gaps(eight, [span(2, 6, 6), span(1, 3, 3)], 150)).toEqual({
      earlier: [
        { ...gap(2, 2, 1, 2), beforeDigest: DigestId.make(1) },
        { ...gap(5, 5, 1, 2), beforeDigest: DigestId.make(2) },
      ],
      now: gap(7, 8, 2, 2),
    });
  });

  it("covers an item over maxInput alone", () => {
    expect(gaps(items([100, 30000, 100]), [span(1, 3, 3)], maxInput)).toEqual({
      earlier: [{ ...gap(2, 2, 1, 2), beforeDigest: DigestId.make(1) }],
      now: null,
    });
  });

  it("has no earlier entry for adjacent digests and no now without undigested items", () => {
    expect(gaps(items([100, 100]), [span(1, 1, 1), span(2, 2, 2)], maxInput)).toEqual({
      earlier: [],
      now: null,
    });
    expect(gaps(items([100, 100]), [], maxInput)).toEqual({ earlier: [], now: gap(1, 2, 2, 2) });
  });
});

describe("chunks", () => {
  const items = conversation([10000, 10000, 4000, 30000, 5000]);

  it("splits at maxInput and keeps an oversize item alone", () => {
    expect(chunks(items, range(3, 31), maxInput)).toEqual([
      range(3, 12),
      range(20, 20),
      range(31, 31),
    ]);
  });

  it("ignores items outside the range", () => {
    expect(chunks(conversation([20000, 10000, 4000, 30000, 5000]), range(7, 12), maxInput)).toEqual(
      [range(7, 12)],
    );
  });
});

describe("context", () => {
  const inputItem = (seq: number, body: string): InputItem => ({
    seq,
    occurred_at: "2026-10-28T09:00:00Z",
    from: { name: "Ana", address: "ana@example.com" },
    from_me: false,
    title: null,
    body_new: body,
  });

  const codePoints = (text: string) => [...text].length;

  const entryChars = (entry: ContextEntry) =>
    entry.kind === "item"
      ? codePoints(entry.body)
      : codePoints(entry.headline) +
        entry.topics.reduce(
          (sum, topic) => sum + codePoints(topic.title) + codePoints(topic.body),
          0,
        );

  const digest: DigestText = {
    fromSeq: 7,
    toSeq: 12,
    headline: "h".repeat(10),
    topics: [{ title: "t".repeat(5), state: "open", body: "u".repeat(20), seqs: [7, 12] }],
  };

  const items = (oldest: string, latest: string) => [
    inputItem(3, oldest),
    inputItem(7, "b".repeat(50)),
    inputItem(12, "c".repeat(50)),
    inputItem(20, latest),
    inputItem(31, "e".repeat(50)),
  ];

  it("replaces covered items with their digest once, oldest first", () => {
    const entries = context(items("a".repeat(100), "d".repeat(200)), [digest], 31, 6000);
    expect(entries.map((entry) => (entry.kind === "item" ? entry.seq : entry.kind))).toEqual([
      3,
      "digest",
      20,
    ]);
    expect(entries[1]).toEqual({
      kind: "digest",
      from_seq: 7,
      to_seq: 12,
      headline: digest.headline,
      topics: digest.topics,
    });
    expect(entries[0]).toMatchObject({ kind: "item", seq: 3, body: "a".repeat(100) });
    expect(entries[2]).toMatchObject({ kind: "item", seq: 20, body: "d".repeat(200) });
  });

  it("truncates the oldest item with a trailing ellipsis to stay within the budget", () => {
    const entries = context(items("𠀀".repeat(5000), "d".repeat(4000)), [digest], 31, 6000);
    expect(entries.reduce((sum, entry) => sum + entryChars(entry), 0)).toBeLessThanOrEqual(6000);
    const oldest = entries[0];
    expect(oldest?.kind === "item" && oldest.seq).toBe(3);
    expect(oldest?.kind === "item" && oldest.body).toBe(`${"𠀀".repeat(6000 - 4035 - 1)}…`);
  });
});
