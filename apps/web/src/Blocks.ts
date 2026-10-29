import type { Conversation } from "@weir/daemon/Api";

export type Detail = typeof Conversation.Type;
export type ItemSummary = Detail["items"][number];
export type Digest = Detail["digests"][number];
export type Topic = Digest["topics"][number];

export type TopicKey = `${number}:${number}`;
export const topicKey = (digest: Digest, index: number): TopicKey => `${digest.id}:${index}`;

export type Shape = "card" | "row";

export type ReaderUi = {
  readonly shapes: ReadonlyMap<number, Shape>;
  readonly earlier: boolean;
  readonly originals: ReadonlySet<TopicKey>;
};

export const closedUi: ReaderUi = { shapes: new Map(), earlier: false, originals: new Set() };

export type Bubbles = {
  readonly _tag: "Bubbles";
  readonly me: boolean;
  readonly from: ItemSummary["from"];
  readonly at: string;
  readonly items: ReadonlyArray<ItemSummary>;
};

export type TopicView = {
  readonly key: TopicKey;
  readonly topic: Topic;
  readonly open: boolean;
  readonly items: ReadonlyArray<ItemSummary>;
  readonly groups: ReadonlyArray<Bubbles>;
};

export type MarkerKind = "last-read" | "all-new";

export type Block =
  | { readonly _tag: "Marker"; readonly kind: MarkerKind; readonly newCount: number }
  | {
      readonly _tag: "EarlierFold";
      readonly digests: ReadonlyArray<Digest>;
      readonly items: ReadonlyArray<ItemSummary>;
    }
  | {
      readonly _tag: "DigestRow";
      readonly digest: Digest;
      readonly items: ReadonlyArray<ItemSummary>;
    }
  | {
      readonly _tag: "DigestCard";
      readonly digest: Digest;
      readonly items: ReadonlyArray<ItemSummary>;
      readonly topics: ReadonlyArray<TopicView>;
    }
  | { readonly _tag: "GapBar"; readonly before_digest: number; readonly run_items: number }
  | { readonly _tag: "Tail"; readonly items: ReadonlyArray<ItemSummary> }
  | Bubbles;

const pause = 5 * 60 * 1000;
const shownReadRows = 4;

const sender = (item: ItemSummary) => (item.from_me ? true : item.from.address);

const startsGroup = (previous: ItemSummary | undefined, item: ItemSummary) =>
  previous === undefined ||
  sender(previous) !== sender(item) ||
  Date.parse(item.occurred_at) - Date.parse(previous.occurred_at) >= pause;

const group = (items: ReadonlyArray<ItemSummary>, breakBefore: (item: ItemSummary) => boolean) =>
  items.reduce<Array<Bubbles>>((groups, item) => {
    const current = groups.at(-1);
    if (current === undefined || breakBefore(item) || startsGroup(current.items.at(-1), item)) {
      groups.push({
        _tag: "Bubbles",
        me: item.from_me,
        from: item.from,
        at: item.occurred_at,
        items: [item],
      });
    } else {
      groups[groups.length - 1] = { ...current, items: [...current.items, item] };
    }
    return groups;
  }, []);

type Segment =
  | { readonly _tag: "Run"; readonly items: ReadonlyArray<ItemSummary>; readonly before: Digest }
  | {
      readonly _tag: "Digested";
      readonly digest: Digest;
      readonly items: ReadonlyArray<ItemSummary>;
    }
  | { readonly _tag: "Tail"; readonly items: ReadonlyArray<ItemSummary> };

const segments = (detail: Detail): ReadonlyArray<Segment> => {
  const out: Array<Segment> = [];
  let at = 0;
  const { items } = detail;
  const take = (below: (seq: number) => boolean) => {
    const start = at;
    while (at < items.length && below(items[at]?.seq ?? Number.POSITIVE_INFINITY)) at++;
    return items.slice(start, at);
  };
  for (const digest of detail.digests.toSorted((a, b) => a.from_seq - b.from_seq)) {
    const run = take((seq) => seq < digest.from_seq);
    if (run.length > 0) out.push({ _tag: "Run", items: run, before: digest });
    out.push({ _tag: "Digested", digest, items: take((seq) => seq <= digest.to_seq) });
  }
  const tail = items.slice(at);
  if (tail.length > 0) out.push({ _tag: "Tail", items: tail });
  return out;
};

export const reader = (detail: Detail, frozenSeen: number, ui: ReaderUi): ReadonlyArray<Block> => {
  const newCount = detail.items.filter(({ seq }) => seq > frozenSeen).length;
  const segs = segments(detail);
  const shape = (digest: Digest): Shape =>
    ui.shapes.get(digest.id) ?? (digest.to_seq > frozenSeen ? "card" : "row");
  const readRows = segs.flatMap((seg) =>
    seg._tag === "Digested" && seg.digest.to_seq <= frozenSeen && shape(seg.digest) === "row"
      ? [seg]
      : [],
  );
  const folded = new Set(
    !ui.earlier && readRows.length > shownReadRows ? readRows.slice(0, -shownReadRows) : [],
  );

  const blocks: Array<Block> = [];
  let marked = newCount === 0;
  const mark = (holdsNew: boolean) => {
    if (marked || !holdsNew) return;
    marked = true;
    blocks.push({ _tag: "Marker", kind: frozenSeen === 0 ? "all-new" : "last-read", newCount });
  };
  const bubbles = (items: ReadonlyArray<ItemSummary>) => {
    const firstNew = marked ? undefined : items.find(({ seq }) => seq > frozenSeen);
    for (const run of group(items, (item) => item === firstNew)) {
      mark(run.items[0] === firstNew);
      blocks.push(run);
    }
  };

  for (const seg of segs) {
    switch (seg._tag) {
      case "Run": {
        bubbles(seg.items);
        const gap = detail.digest.earlier?.find(
          ({ before_digest }) => before_digest === seg.before.id,
        );
        blocks.push({
          _tag: "GapBar",
          before_digest: seg.before.id,
          run_items: gap?.run_items ?? seg.items.length,
        });
        break;
      }
      case "Digested": {
        const { digest, items } = seg;
        if (folded.has(seg)) {
          const previous = blocks.at(-1);
          if (previous?._tag === "EarlierFold") {
            blocks[blocks.length - 1] = {
              ...previous,
              digests: [...previous.digests, digest],
              items: [...previous.items, ...items],
            };
          } else {
            blocks.push({ _tag: "EarlierFold", digests: [digest], items });
          }
          break;
        }
        mark(digest.to_seq > frozenSeen);
        if (shape(digest) === "row") {
          blocks.push({ _tag: "DigestRow", digest, items });
          break;
        }
        const bySeq = new Map(items.map((item) => [item.seq, item]));
        blocks.push({
          _tag: "DigestCard",
          digest,
          items,
          topics: digest.topics.map((topic, index) => {
            const key = topicKey(digest, index);
            const covered = topic.seqs.flatMap((seq) => bySeq.get(seq) ?? []);
            const open = ui.originals.has(key);
            return {
              key,
              topic,
              open,
              items: covered,
              groups: open ? group(covered, () => false) : [],
            };
          }),
        });
        break;
      }
      case "Tail":
        blocks.push({ _tag: "Tail", items: seg.items });
        bubbles(seg.items);
    }
  }
  return blocks;
};

export const lastSeq = (detail: Detail) => detail.items.at(-1)?.seq ?? 0;

export const participants = (detail: Detail) => new Set(detail.items.map(sender)).size;
