import { type Detail, type Digest, type ReaderUi, type TopicKey, topicKey } from "./Blocks.ts";

export type Hit =
  | { readonly _tag: "Item"; readonly seq: number; readonly field: "body" | "from" }
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

export const hits = (detail: Detail, pattern: RegExp | null): ReadonlyArray<Hit> => {
  if (pattern === null) return [];
  const matches = (text: string) => text.search(pattern) !== -1;
  const placed: Array<{ readonly at: ReadonlyArray<number>; readonly hit: Hit }> = [];
  for (const digest of detail.digests) {
    if (matches(digest.headline)) {
      placed.push({ at: [digest.from_seq, 0, 0, 0], hit: { _tag: "Headline", digest: digest.id } });
    }
    digest.topics.forEach((topic, index) => {
      if (matches(topic.title) || matches(topic.body)) {
        placed.push({
          at: [digest.from_seq, 1, index, 0],
          hit: { _tag: "Topic", key: topicKey(digest, index) },
        });
      }
    });
  }
  for (const { seq, from, body_new } of detail.items) {
    const field = matches(body_new)
      ? "body"
      : matches(from.name === "" ? from.address : `${from.name} <${from.address}>`)
        ? "from"
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
  const digest = holding(detail, hit);
  if (digest === undefined) return ui;
  const topic =
    hit._tag === "Item" ? digest.topics.findIndex(({ seqs }) => seqs.includes(hit.seq)) : -1;
  return {
    ...ui,
    shapes: new Map(ui.shapes).set(digest.id, "card"),
    originals: topic === -1 ? ui.originals : new Set(ui.originals).add(topicKey(digest, topic)),
  };
};
