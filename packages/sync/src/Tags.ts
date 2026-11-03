import { groupNameOf, type TagConfig } from "@weir/contract/Config";
import type { RuleInput } from "@weir/contract/Rule";
import * as Read from "@weir/store/Read";
import type { ConversationId, ConversationTagRow, Seq, SourcedItemRow } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { match, ruleInput } from "./Match.ts";

export type Tags = ReadonlyArray<Pick<TagConfig, "name" | "match">>;

const recomputeBatch = 100;

const tagRows = (tags: Tags, items: ReadonlyArray<SourcedItemRow>): Array<ConversationTagRow> => {
  const conversations = new Map<
    ConversationId,
    { readonly group: string | null; readonly inputs: Array<RuleInput> }
  >();
  for (const item of items) {
    const conversation = conversations.get(item.conversationId);
    if (conversation === undefined) {
      conversations.set(item.conversationId, {
        group: groupNameOf(item.conversationKey),
        inputs: [ruleInput(item)],
      });
    } else conversation.inputs.push(ruleInput(item));
  }
  return [...conversations].flatMap(([conversationId, { group, inputs }]) =>
    tags
      .filter((tag) => inputs.some((input) => match(tag.match, input, group)))
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
