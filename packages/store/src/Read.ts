import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ConversationId,
  ConversationRow,
  ConversationTagRow,
  ItemRow,
  type Seq,
  SourcedItemRow,
  StreamId,
  StreamRow,
  TagStateRow,
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

const decodeSourcedItems = Schema.decodeUnknownEffect(Schema.Array(SourcedItemRow));
const decodeConversationIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: ConversationId })),
);

export type LiveItemsQuery =
  | { readonly conversationIds: ReadonlyArray<ConversationId> }
  | { readonly seqs: ReadonlyArray<Seq> };

export const liveItems = Effect.fnUntraced(function* (query: LiveItemsQuery) {
  const sql = yield* SqlClient.SqlClient;
  const selected =
    "seqs" in query
      ? sql.in("item.seq", query.seqs)
      : sql.in("item.conversation_id", query.conversationIds);
  return yield* decodeSourcedItems(
    yield* sql`SELECT item.*, conversation.source_id FROM item
      JOIN conversation ON conversation.id = item.conversation_id
      WHERE item.deleted_at IS NULL AND ${selected}
      ORDER BY item.conversation_id, item.seq`,
  );
});

export const conversationIds = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeConversationIds(yield* sql`SELECT id FROM conversation ORDER BY id`);
  return rows.map(({ id }) => id);
});

const decodeStreamIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: StreamId })));

export const streamId = Effect.fnUntraced(function* (sourceId: string, externalId: string) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeStreamIds(
      yield* sql`SELECT id FROM stream WHERE source_id = ${sourceId} AND external_id = ${externalId}`,
    ),
  ).pipe(Option.map(({ id }) => id));
});

const decodeStreams = Schema.decodeUnknownEffect(Schema.Array(StreamRow));

export const streams = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeStreams(yield* sql`SELECT * FROM stream ORDER BY source_id, id`);
});

const decodeTagStates = Schema.decodeUnknownEffect(Schema.Array(TagStateRow));

export const tagStates = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeTagStates(yield* sql`SELECT * FROM tag_state ORDER BY name`);
});

export const TagCount = Schema.Struct({
  tag: Schema.NullOr(Schema.String),
  conversations: Schema.Int,
  unread: Schema.Int,
  open: Schema.Int,
});
export type TagCount = typeof TagCount.Type;

const decodeTagCounts = Schema.decodeUnknownEffect(Schema.Array(TagCount));

export const tagCounts = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeTagCounts(
    yield* sql`WITH live AS (
        SELECT c.id,
          coalesce(s.muted, 0) = 0 AND c.last_seq > coalesce(s.cleared_seq, 0) AS open,
          coalesce(s.muted, 0) = 0 AND c.last_seq > coalesce(s.cleared_seq, 0)
            AND c.last_seq > coalesce(s.seen_seq, 0) AS unread
        FROM conversation c LEFT JOIN conversation_state s ON s.conversation_id = c.id
        WHERE EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL)
      )
      SELECT conversation_tag.tag, count(*) AS conversations,
        sum(live.unread) AS unread, sum(live.open) AS open
      FROM live LEFT JOIN conversation_tag ON conversation_tag.conversation_id = live.id
      GROUP BY conversation_tag.tag
      ORDER BY conversation_tag.tag`,
  );
});
