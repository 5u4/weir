import { hast, leaves } from "@weir/daemon/Markdown";
import { senderLabel } from "@weir/daemon/Match";
import {
  type Detail,
  type Digest,
  type ReaderUi,
  type TopicKey,
  topicKey,
  uncitedKey,
} from "./Blocks.ts";

export type Hit =
  | {
      readonly _tag: "Item";
      readonly seq: number;
      readonly field: "body" | "from" | "source";
    }
  | { readonly _tag: "Topic"; readonly key: TopicKey }
  | { readonly _tag: "Headline"; readonly digest: number };

export const hitKey = (
  hit:
    | { readonly _tag: "Item"; readonly seq: number }
    | { readonly _tag: "Topic"; readonly key: TopicKey }
    | { readonly _tag: "Headline"; readonly digest: number },
) =>
  hit._tag === "Item" ? `i:${hit.seq}` : hit._tag === "Topic" ? `t:${hit.key}` : `h:${hit.digest}`;

const covering = (detail: Detail, seq: number) =>
  detail.digests.find(({ from_seq, to_seq }) => from_seq <= seq && seq <= to_seq);

export const matches = (text: string, pattern: RegExp) => text.search(pattern) !== -1;

export const hits = (detail: Detail, pattern: RegExp | null): ReadonlyArray<Hit> => {
  if (pattern === null) return [];
  const placed: Array<{ readonly at: ReadonlyArray<number>; readonly hit: Hit }> = [];
  for (const digest of detail.digests) {
    if (matches(digest.headline, pattern)) {
      placed.push({ at: [digest.from_seq, 0, 0, 0], hit: { _tag: "Headline", digest: digest.id } });
    }
    digest.topics.forEach((topic, index) => {
      if (matches(topic.title, pattern) || matches(topic.body, pattern)) {
        placed.push({
          at: [digest.from_seq, 1, index, 0],
          hit: { _tag: "Topic", key: topicKey(digest, index) },
        });
      }
    });
  }
  for (const { seq, from, body_new, stream } of detail.items) {
    const field = leaves(hast(body_new)).some((leaf) => matches(leaf, pattern))
      ? "body"
      : matches(senderLabel(from.name, from.address), pattern)
        ? "from"
        : matches(stream, pattern)
          ? "source"
          : null;
    if (field === null) continue;
    const digest = covering(detail, seq);
    const topic = digest?.topics.findIndex(({ seqs }) => seqs.includes(seq)) ?? -1;
    placed.push({
      at:
        digest === undefined
          ? [seq, 0, 0, 0]
          : topic === -1
            ? [digest.from_seq, 2, 0, seq]
            : [digest.from_seq, 1, topic, seq],
      hit: { _tag: "Item", seq, field },
    });
  }
  return placed
    .toSorted((left, right) => {
      const at = left.at.findIndex((value, index) => value !== right.at[index]);
      return at === -1 ? 0 : (left.at[at] ?? 0) - (right.at[at] ?? 0);
    })
    .map(({ hit }) => hit);
};

export const matchedIn = (detail: Detail, pattern: RegExp | null) =>
  pattern === null
    ? "Matched in filters"
    : matches(detail.title, pattern)
      ? "Matched in Title"
      : "Matched the conversation";

const holding = (detail: Detail, hit: Hit): Digest | undefined => {
  switch (hit._tag) {
    case "Item":
      return covering(detail, hit.seq);
    case "Topic":
      return detail.digests.find(({ id }) => hit.key.startsWith(`${id}:`));
    case "Headline":
      return detail.digests.find(({ id }) => id === hit.digest);
  }
};

export const reveal = (ui: ReaderUi, detail: Detail, hit: Hit): ReaderUi => {
  const opened =
    hit._tag === "Item" && hit.field === "body" && !ui.long.has(hit.seq)
      ? { ...ui, long: new Set(ui.long).add(hit.seq) }
      : ui;
  const digest = holding(detail, hit);
  if (digest === undefined) return opened;
  const shapes = new Map(ui.shapes).set(digest.id, "card");
  if (hit._tag !== "Item") return { ...opened, shapes };
  const topic = digest.topics.findIndex(({ seqs }) => seqs.includes(hit.seq));
  return {
    ...opened,
    shapes,
    originals: new Set(ui.originals).add(
      topic === -1 ? uncitedKey(digest) : topicKey(digest, topic),
    ),
  };
};
