import { type GroupConfig, groupKeyPrefix } from "@weir/contract/Config";
import type { RawItem } from "@weir/contract/Source";
import * as Read from "@weir/store/Read";
import type { SourcedItemRow, StreamRow } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { match, type RuleInput, ruleInput } from "./Match.ts";

export type Groups = ReadonlyArray<Pick<GroupConfig, "name" | "match">>;

const regroupBatch = 100;

const threadOf = (item: Pick<RawItem, "threadId" | "containerId">) =>
  item.threadId ?? item.containerId;

const keysOf = (groups: Groups, inputs: ReadonlyMap<string, ReadonlyArray<RuleInput>>) =>
  new Map(
    [...inputs].map(([thread, threadInputs]) => {
      const group = groups.find((candidate) =>
        threadInputs.some((input) => match(candidate.match, input)),
      );
      return [thread, group === undefined ? thread : `${groupKeyPrefix}${group.name}`];
    }),
  );

const collect = (inputs: Map<string, Array<RuleInput>>, thread: string, input: RuleInput) => {
  const threadInputs = inputs.get(thread);
  if (threadInputs === undefined) inputs.set(thread, [input]);
  else threadInputs.push(input);
};

const movesOf = (keys: ReadonlyMap<string, string>, items: ReadonlyArray<SourcedItemRow>) =>
  items.map((item) => ({ seq: item.seq, key: keys.get(threadOf(item)) ?? threadOf(item) }));

export const joinThreads = Effect.fnUntraced(function* (
  stream: StreamRow,
  upserts: ReadonlyArray<RawItem>,
  deletedThreads: ReadonlyArray<string>,
  groups: Groups,
) {
  const items = [...new Map(upserts.map((item) => [item.externalId, item])).values()];
  const threads = [...new Set([...items.map(threadOf), ...deletedThreads])];
  if (groups.length === 0 || threads.length === 0) {
    return { keys: new Map<string, string>(), moved: [] };
  }
  const me = new Set(stream.me.map((address) => address.toLowerCase()));
  const paged = new Set(items.map(({ externalId }) => externalId));
  const stored = yield* Read.liveItems({ sourceId: stream.sourceId, threads });
  const inputs = new Map<string, Array<RuleInput>>();
  for (const item of stored) {
    if (item.streamId === stream.id && paged.has(item.externalId)) continue;
    collect(inputs, threadOf(item), ruleInput(item));
  }
  for (const item of items) {
    const address = item.from.address.toLowerCase();
    collect(inputs, threadOf(item), {
      source: stream.sourceId,
      threadId: item.threadId,
      containerId: item.containerId,
      containerName: item.containerName,
      title: item.title,
      from: { name: item.from.name, address },
      fromMe: me.has(address),
      body: item.body,
      raw: item.raw,
    });
  }
  const keys = keysOf(groups, inputs);
  const moved = yield* Write.moveItems(stream.sourceId, movesOf(keys, stored));
  return { keys, moved };
});

export const regroupThreads = Effect.fnUntraced(function* (
  sourceId: string,
  threads: ReadonlyArray<string>,
  groups: Groups,
) {
  const items = yield* Read.liveItems({ sourceId, threads });
  const inputs = new Map<string, Array<RuleInput>>();
  for (const item of items) collect(inputs, threadOf(item), ruleInput(item));
  return yield* Write.moveItems(sourceId, movesOf(keysOf(groups, inputs), items));
});

export const regroupAll = Effect.fnUntraced(function* (groups: Groups) {
  const bySource = Arr.groupBy(yield* Read.threads(), ({ sourceId }) => sourceId);
  yield* Effect.forEach(
    Object.entries(bySource),
    ([sourceId, rows]) =>
      Effect.forEach(
        Arr.chunksOf(
          rows.map(({ thread }) => thread),
          regroupBatch,
        ),
        (threads) => regroupThreads(sourceId, threads, groups),
        { discard: true },
      ),
    { discard: true },
  );
});
