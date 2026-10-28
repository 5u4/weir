import type { TagConfig } from "@weir/contract/Config";
import * as Read from "@weir/store/Read";
import type { ConversationId, ConversationTagRow, Seq, SourcedItemRow } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { match, type RuleInput, ruleInput } from "./Match.ts";

export type Tags = ReadonlyArray<Pick<TagConfig, "name" | "match">>;

const recomputeBatch = 100;

const tagRows = (tags: Tags, items: ReadonlyArray<SourcedItemRow>): Array<ConversationTagRow> => {
  const inputs = new Map<ConversationId, Array<RuleInput>>();
  for (const item of items) {
    const conversationInputs = inputs.get(item.conversationId);
    if (conversationInputs === undefined) inputs.set(item.conversationId, [ruleInput(item)]);
    else conversationInputs.push(ruleInput(item));
  }
  return [...inputs].flatMap(([conversationId, conversationInputs]) =>
    tags
      .filter((tag) => conversationInputs.some((input) => match(tag.match, input)))
      .map(({ name }) => ({ conversationId, tag: name })),
  );
};

export const appendItemTags = Effect.fnUntraced(function* (tags: Tags, seqs: ReadonlyArray<Seq>) {
  if (seqs.length === 0) return;
  yield* Write.addConversationTags(tagRows(tags, yield* Read.liveItems({ seqs })));
});

export const recomputeTags = Effect.fnUntraced(function* (
  tags: Tags,
  conversationIds: ReadonlyArray<ConversationId>,
) {
  if (conversationIds.length === 0) return;
  yield* Write.replaceConversationTags(
    conversationIds,
    tagRows(tags, yield* Read.liveItems({ conversationIds })),
  );
});

export const recomputeAllTags = Effect.fnUntraced(function* (tags: Tags) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.forEach(
      Arr.chunksOf(yield* Read.conversationIds(), recomputeBatch),
      (conversationIds) => recomputeTags(tags, conversationIds),
      { discard: true },
    ),
  );
});
