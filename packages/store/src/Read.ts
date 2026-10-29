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
  type DigestId,
  DigestRow,
  DigestRunRow,
  ItemLiteRow,
  ItemRow,
  ListedConversationRow,
  Seq,
  SourcedItemRow,
  StreamId,
  StreamRow,
  TagStateRow,
  UtcIso,
} from "./Rows.ts";

export type TagFilter =
  | { readonly _tag: "Tag"; readonly name: string }
  | { readonly _tag: "Untagged" };

export type View = TagFilter | { readonly _tag: "Cleared" };

export type RowQuery = View | { readonly _tag: "Ids"; readonly ids: ReadonlyArray<ConversationId> };

export interface SearchQuery {
  readonly query: string;
  readonly tag?: TagFilter;
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

const tagCondition = (sql: SqlClient.SqlClient, tag: TagFilter) =>
  tag._tag === "Tag"
    ? sql`EXISTS (SELECT 1 FROM conversation_tag WHERE conversation_tag.conversation_id = c.id AND conversation_tag.tag = ${tag.name})`
    : sql`NOT EXISTS (SELECT 1 FROM conversation_tag WHERE conversation_tag.conversation_id = c.id)`;

const listed = (sql: SqlClient.SqlClient) => sql`listed AS (
    SELECT c.*,
      coalesce(s.seen_seq, 0) AS seen_seq,
      coalesce(s.cleared_seq, 0) AS cleared_seq,
      coalesce(s.muted, 0) AS muted,
      CASE
        WHEN coalesce(s.muted, 0) = 1 THEN 'muted'
        WHEN c.last_seq <= coalesce(s.cleared_seq, 0) THEN 'done'
        WHEN c.last_seq > coalesce(s.seen_seq, 0) THEN 'unread'
        ELSE 'read'
      END AS state
    FROM conversation c LEFT JOIN conversation_state s ON s.conversation_id = c.id
    WHERE EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL)
  )`;

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
  if (tag !== undefined) conditions.push(tagCondition(sql, tag));
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
    yield* sql`WITH ${listed(sql)}
      SELECT conversation_tag.tag, count(*) AS conversations,
        sum(listed.state = 'unread') AS unread,
        sum(listed.state IN ('unread', 'read')) AS open
      FROM listed LEFT JOIN conversation_tag ON conversation_tag.conversation_id = listed.id
      GROUP BY conversation_tag.tag
      ORDER BY conversation_tag.tag`,
  );
});

const decodeListed = Schema.decodeUnknownEffect(Schema.Array(ListedConversationRow));

const rowSenders = 2;

export const conversations = Effect.fnUntraced(function* (query: RowQuery) {
  const sql = yield* SqlClient.SqlClient;
  const open = sql`c.state IN ('unread', 'read')`;
  const condition =
    query._tag === "Ids"
      ? sql.in("c.id", query.ids)
      : query._tag === "Cleared"
        ? sql`c.state IN ('done', 'muted')`
        : sql.and([open, tagCondition(sql, query)]);
  return yield* decodeListed(
    yield* sql`WITH ${listed(sql)}
      SELECT c.*,
        (SELECT json_group_array(tag) FROM
          (SELECT tag FROM conversation_tag WHERE conversation_id = c.id ORDER BY tag)) AS tags,
        (SELECT count(*) FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL
          AND item.seq > c.seen_seq) AS new_items,
        (SELECT count(*) FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL)
          AS items,
        (SELECT count(DISTINCT lower(item.from_address)) FROM item
          WHERE item.conversation_id = c.id AND item.deleted_at IS NULL) AS participants,
        (SELECT json_object('name', item.from_name, 'address', item.from_address,
            'me', json(iif(item.from_me, 'true', 'false'))) FROM item
          WHERE item.conversation_id = c.id AND item.deleted_at IS NULL
          ORDER BY item.from_me, item.seq DESC LIMIT 1) AS "from",
        (SELECT json_group_array(json_object('name', name, 'address', address,
            'me', json(iif(me, 'true', 'false')))) FROM
          (SELECT item.from_name AS name, item.from_address AS address, item.from_me AS me,
              min(item.seq) AS first_seq
            FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL
            GROUP BY lower(item.from_address) ORDER BY first_seq LIMIT ${rowSenders})) AS senders,
        last.from_name AS last_from_name,
        last.from_address AS last_from_address,
        last.from_me AS last_from_me,
        last.body_new AS last_body_new,
        (SELECT CASE WHEN digest.to_seq >= c.last_seq THEN digest.headline END FROM digest
          WHERE digest.conversation_id = c.id ORDER BY digest.from_seq DESC, digest.id DESC LIMIT 1)
          AS covering_headline
      FROM listed c JOIN item last ON last.seq = c.last_seq
      WHERE ${condition}
      ORDER BY c.last_at DESC, c.id DESC`,
  );
});

export const conversation = Effect.fnUntraced(function* (id: ConversationId) {
  return Arr.head(yield* conversations({ _tag: "Ids", ids: [id] }));
});

export const StateTotals = Schema.Struct({ unread: Schema.Int, cleared: Schema.Int });

const decodeStateTotals = Schema.decodeUnknownEffect(Schema.Tuple([StateTotals]));

export const stateTotals = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [totals] = yield* decodeStateTotals(
    yield* sql`WITH ${listed(sql)}
      SELECT coalesce(sum(state = 'unread'), 0) AS unread,
        coalesce(sum(state IN ('done', 'muted')), 0) AS cleared
      FROM listed`,
  );
  return totals;
});

export const UnreadSender = Schema.Struct({
  tag: Schema.NullOr(Schema.String),
  name: Schema.String,
  address: Schema.String,
});
export type UnreadSender = typeof UnreadSender.Type;

const decodeUnreadSenders = Schema.decodeUnknownEffect(Schema.Array(UnreadSender));

export const unreadSenders = Effect.fnUntraced(function* (perTag: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeUnreadSenders(
    yield* sql`WITH ${listed(sql)},
      latest AS (
        SELECT listed.id AS conversation_id, item.from_name AS name,
          item.from_address AS address, item.occurred_at AS at,
          row_number() OVER (PARTITION BY listed.id ORDER BY item.seq DESC) AS position
        FROM listed
        JOIN item ON item.conversation_id = listed.id AND item.deleted_at IS NULL
          AND item.from_me = 0
        WHERE listed.state = 'unread'
      ),
      sender AS (
        SELECT conversation_tag.tag, latest.name, latest.address, max(latest.at) AS at
        FROM latest
        LEFT JOIN conversation_tag ON conversation_tag.conversation_id = latest.conversation_id
        WHERE latest.position = 1
        GROUP BY conversation_tag.tag, lower(latest.address)
      ),
      ranked AS (
        SELECT *, row_number() OVER (PARTITION BY tag ORDER BY at DESC, address) AS rank FROM sender
      )
      SELECT tag, name, address FROM ranked WHERE rank <= ${perTag} ORDER BY tag, rank`,
  );
});

const decodeDigests = Schema.decodeUnknownEffect(Schema.Array(DigestRow));

export const digests = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeDigests(
    yield* sql`SELECT * FROM digest WHERE ${sql.in("conversation_id", conversationIds)}
      ORDER BY conversation_id, from_seq, id`,
  );
});

export const digest = Effect.fnUntraced(function* (id: DigestId) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(yield* decodeDigests(yield* sql`SELECT * FROM digest WHERE id = ${id}`));
});

const decodeItemsLite = Schema.decodeUnknownEffect(Schema.Array(ItemLiteRow));

export const itemsLite = Effect.fnUntraced(function* (conversationId: ConversationId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeItemsLite(
    yield* sql`SELECT seq, occurred_at, length(body_new) AS chars FROM item
      WHERE conversation_id = ${conversationId} AND deleted_at IS NULL ORDER BY seq`,
  );
});

const decodeAiSince = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ aiSince: Schema.NullOr(UtcIso) })]),
);

export const aiSince = Effect.fnUntraced(function* (conversationId: ConversationId) {
  const sql = yield* SqlClient.SqlClient;
  const [{ aiSince }] = yield* decodeAiSince(
    yield* sql`SELECT min(tag_state.ai_since) AS ai_since FROM conversation_tag
      JOIN tag_state ON tag_state.name = conversation_tag.tag
      WHERE conversation_tag.conversation_id = ${conversationId}`,
  );
  return Option.fromNullOr(aiSince);
});

export const aiConversations = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeConversationIds(
    yield* sql`SELECT DISTINCT conversation_tag.conversation_id AS id FROM conversation_tag
      JOIN tag_state ON tag_state.name = conversation_tag.tag
      ORDER BY id`,
  );
  return rows.map(({ id }) => id);
});

const decodeDigestRuns = Schema.decodeUnknownEffect(Schema.Array(DigestRunRow));

export const lastDigestRun = Effect.fnUntraced(function* (conversationId: ConversationId) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeDigestRuns(
      yield* sql`SELECT * FROM digest_run WHERE conversation_id = ${conversationId}
        ORDER BY id DESC LIMIT 1`,
    ),
  );
});

export const DigestRunTotals = Schema.Struct({
  at: UtcIso,
  written: Schema.Int,
  failed: Schema.Int,
  avgMs: Schema.NullOr(Schema.Int),
});
export type DigestRunTotals = typeof DigestRunTotals.Type;

const decodeDigestRunTotals = Schema.decodeUnknownEffect(Schema.Array(DigestRunTotals));

export const digestRunsSince = Effect.fnUntraced(function* (since: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeDigestRunTotals(
      yield* sql`SELECT max(started_at) AS at, sum(ok = 1) AS written, sum(ok = 0) AS failed,
          CAST(round(avg(CASE WHEN ok = 1 THEN ms END)) AS INTEGER) AS avg_ms
        FROM digest_run WHERE started_at >= ${yield* Schema.encodeEffect(UtcIso)(since)}
        HAVING count(*) > 0`,
    ),
  );
});

export const HitItem = Schema.Struct({
  conversationId: ConversationId,
  seq: Seq,
  fromName: Schema.String,
  fromAddress: Schema.String,
  bodyNew: Schema.String,
  streamName: Schema.String,
});
export type HitItem = typeof HitItem.Type;

const decodeHitItems = Schema.decodeUnknownEffect(Schema.Array(HitItem));

export const hitItems = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeHitItems(
    yield* sql`SELECT item.conversation_id, item.seq, item.from_name, item.from_address,
        item.body_new, stream.name AS stream_name
      FROM item JOIN stream ON stream.id = item.stream_id
      WHERE item.deleted_at IS NULL AND ${sql.in("item.conversation_id", conversationIds)}
      ORDER BY item.conversation_id, item.occurred_at DESC, item.seq DESC`,
  );
});

const decodeMaxSeq = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ seq: Seq })]));

export const maxSeq = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [{ seq }] = yield* decodeMaxSeq(yield* sql`SELECT coalesce(max(seq), 0) AS seq FROM item`);
  return seq;
});
