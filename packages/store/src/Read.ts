import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type ConversationId,
  ConversationRow,
  ConversationTagRow,
  ItemRow,
  type Seq,
  UtcIso,
} from "./Rows.ts";

export interface SearchQuery {
  readonly query: string;
  readonly tag?: string;
  readonly source?: string;
  readonly from?: string;
  readonly since?: DateTime.Utc;
  readonly limit?: number;
}

export interface ConversationDetail {
  readonly conversation: ConversationRow;
  readonly items: ReadonlyArray<ItemRow>;
  readonly tags: ReadonlyArray<string>;
}

const decodeConversations = Schema.decodeUnknownEffect(Schema.Array(ConversationRow));
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(ItemRow));
const decodeTags = Schema.decodeUnknownEffect(Schema.Array(ConversationTagRow));

const contains = (sql: SqlClient.SqlClient, column: string, value: string) =>
  sql`${sql.literal(column)} LIKE '%' || ${value.replace(/[\\%_]/g, "\\$&")} || '%' ESCAPE '\\'`;

export const search = Effect.fnUntraced(function* ({
  query,
  tag,
  source,
  from,
  since,
  limit,
}: SearchQuery) {
  const sql = yield* SqlClient.SqlClient;
  const terms = query
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map((term, index) =>
      [...term].length >= 3
        ? sql`SELECT ${index} AS term, conversation_id, item_seq FROM search_fts
            WHERE search_fts MATCH ${`"${term.replaceAll('"', '""')}"`}`
        : sql`SELECT ${index} AS term, conversation_id, item_seq FROM search_fts
            WHERE ${contains(sql, "text", term)}`,
    );
  const conditions = [
    sql`EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL)`,
  ];
  if (tag !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM conversation_tag WHERE conversation_tag.conversation_id = c.id AND conversation_tag.tag = ${tag})`,
    );
  }
  if (source !== undefined) conditions.push(sql`c.source_id = ${source}`);
  if (from !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL
        AND (${contains(sql, "item.from_address", from)} OR ${contains(sql, "item.from_name", from)}))`,
    );
  }
  if (since !== undefined)
    conditions.push(sql`c.last_at >= ${yield* Schema.encodeEffect(UtcIso)(since)}`);
  const filtered = sql`WHERE ${sql.and(conditions)}`;
  const limited = limit === undefined ? sql.literal("") : sql`LIMIT ${limit}`;
  return yield* decodeConversations(
    terms.length === 0
      ? yield* sql`SELECT c.* FROM conversation c ${filtered}
          ORDER BY c.last_at DESC, c.id DESC ${limited}`
      : yield* sql`WITH hit AS (${sql.join(" UNION ALL ", false)(terms)}),
          matched AS (
            SELECT hit.conversation_id, max(item.occurred_at) AS matched_at
            FROM hit LEFT JOIN item ON item.seq = hit.item_seq AND item.deleted_at IS NULL
            GROUP BY hit.conversation_id
            HAVING count(DISTINCT hit.term) = ${terms.length}
          )
          SELECT c.* FROM conversation c JOIN matched ON matched.conversation_id = c.id
          ${filtered}
          ORDER BY matched.matched_at DESC, c.id DESC ${limited}`,
  );
});

export const getConversation = Effect.fnUntraced(function* (id: ConversationId) {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* decodeItems(
    yield* sql`SELECT * FROM item WHERE conversation_id = ${id} AND deleted_at IS NULL ORDER BY seq`,
  );
  if (items.length === 0) return Option.none<ConversationDetail>();
  const conversation = Arr.head(
    yield* decodeConversations(yield* sql`SELECT * FROM conversation WHERE id = ${id}`),
  );
  if (Option.isNone(conversation)) return Option.none<ConversationDetail>();
  const tags = yield* decodeTags(
    yield* sql`SELECT * FROM conversation_tag WHERE conversation_id = ${id} ORDER BY tag`,
  );
  return Option.some<ConversationDetail>({
    conversation: conversation.value,
    items,
    tags: tags.map(({ tag }) => tag),
  });
});

export const getItem = Effect.fnUntraced(function* (seq: Seq) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(yield* decodeItems(yield* sql`SELECT * FROM item WHERE seq = ${seq}`));
});
