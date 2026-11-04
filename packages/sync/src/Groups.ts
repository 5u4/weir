import { type GroupConfig, groupKey } from "@weir/contract/Config";
import type { RuleInput } from "@weir/contract/Rule";
import * as Read from "@weir/store/Read";
import type { SourcedItemRow, StreamRow } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { matchItem, ruleInput } from "./Match.ts";

export type Groups = ReadonlyArray<Pick<GroupConfig, "name" | "match">>;

const regroupBatch = 100;

const threadOf = (item: Pick<Write.ItemDraft, "threadId" | "containerId">) =>
  item.threadId ?? item.containerId;

const keysOf = (groups: Groups, inputs: ReadonlyMap<string, ReadonlyArray<RuleInput>>) =>
  new Map(
    [...inputs].map(([thread, threadInputs]) => {
      const group = groups.find((candidate) =>
        threadInputs.some((input) => matchItem(candidate.match, input)),
      );
      return [thread, group === undefined ? thread : groupKey(group.name)];
    }),
  );

const collect = (inputs: Map<string, Array<RuleInput>>, thread: string, input: RuleInput) => {
  const threadInputs = inputs.get(thread);
  if (threadInputs === undefined) inputs.set(thread, [input]);
  else threadInputs.push(input);
};

const keyOf = (keys: ReadonlyMap<string, string>, item: SourcedItemRow) =>
  keys.get(threadOf(item)) ?? threadOf(item);

export const joinThreads = Effect.fnUntraced(function* (
  stream: StreamRow,
  drafts: ReadonlyArray<Write.ItemDraft>,
  deletedThreads: ReadonlyArray<string>,
  groups: Groups,
) {
  const items = [...new Map(drafts.map((item) => [item.externalId, item])).values()];
  const threads = [...new Set([...items.map(threadOf), ...deletedThreads])];
  if (groups.length === 0 || threads.length === 0) {
    return { keys: new Map<string, string>(), moved: [] };
  }
  const paged = new Set(items.map(({ externalId }) => externalId));
  const stored = yield* Read.liveItems({ sourceId: stream.sourceId, threads });
  const inputs = new Map<string, Array<RuleInput>>();
  for (const item of stored) {
    if (item.streamId === stream.id && paged.has(item.externalId)) continue;
    collect(inputs, threadOf(item), ruleInput(item));
  }
  for (const item of items) collect(inputs, threadOf(item), ruleInput(item));
  const keys = keysOf(groups, inputs);
  const quiet = new Set(items.filter(({ refresh }) => refresh !== null).map(threadOf));
  const moved = yield* Write.moveItems(
    stream.sourceId,
    stored.map((item) => ({
      seq: item.seq,
      key: keyOf(keys, item),
      quiet: quiet.has(threadOf(item)),
    })),
  );
  return { keys, moved };
});

const planThreads = Effect.fnUntraced(function* (
  sourceId: string,
  threads: ReadonlyArray<string>,
  groups: Groups,
) {
  const items = yield* Read.liveItems({ sourceId, threads });
  const inputs = new Map<string, Array<RuleInput>>();
  for (const item of items) collect(inputs, threadOf(item), ruleInput(item));
  const keys = keysOf(groups, inputs);
  return items.map((item) => ({
    seq: item.seq,
    conversationId: item.conversationId,
    key: keyOf(keys, item),
  }));
});

export const regroupThreads = Effect.fnUntraced(function* (
  sourceId: string,
  threads: ReadonlyArray<string>,
  groups: Groups,
) {
  const planned = yield* planThreads(sourceId, threads, groups);
  return yield* Write.moveItems(
    sourceId,
    planned.map(({ seq, key }) => ({ seq, key, quiet: false })),
  );
});

const eachThreadBatch = <A, E, R>(
  run: (sourceId: string, threads: ReadonlyArray<string>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const bySource = Arr.groupBy(yield* Read.threads(), ({ sourceId }) => sourceId);
    return yield* Effect.forEach(Object.entries(bySource), ([sourceId, rows]) =>
      Effect.forEach(
        Arr.chunksOf(
          rows.map(({ thread }) => thread),
          regroupBatch,
        ),
        (threads) => run(sourceId, threads),
      ),
    );
  });

export const regroupAll = (groups: Groups) =>
  eachThreadBatch((sourceId, threads) => regroupThreads(sourceId, threads, groups)).pipe(
    Effect.asVoid,
  );

export const planAll = (groups: Groups) =>
  eachThreadBatch((sourceId, threads) => planThreads(sourceId, threads, groups)).pipe(
    Effect.map((batches) => batches.flat(2)),
  );
