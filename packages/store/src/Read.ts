import { CalendarDate } from "@weir/contract/Digest";
import type { RawEvent } from "@weir/contract/Source";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { type EventPriors, noPriors } from "./Events.ts";
import {
  AiStateRow,
  ConversationId,
  ConversationRow,
  ConversationTagRow,
  type DigestId,
  DigestRow,
  DigestRunRow,
  EventDetailRow,
  EventOccurrenceRow,
  FaceBlobRow,
  type FaceHash,
  FaceRow,
  ItemLiteRow,
  ItemRow,
  ListedConversationRow,
  MeetingRow,
  Seq,
  SourcedItemRow,
  StreamId,
  StreamRow,
  UtcIso,
} from "./Rows.ts";

export type TagFilter =
  | { readonly _tag: "Tag"; readonly name: string }
  | { readonly _tag: "Untagged" };

export type View = TagFilter | { readonly _tag: "Cleared" } | { readonly _tag: "Planned" };

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
        WHEN s.plan_kind IS NOT NULL THEN 'planned'
        WHEN c.last_seq <= coalesce(s.cleared_seq, 0) THEN 'done'
        WHEN c.last_seq > coalesce(s.seen_seq, 0) THEN 'unread'
        ELSE 'read'
      END AS state,
      CASE s.plan_kind
        WHEN 'tray' THEN json_object('_tag', 'Tray')
        WHEN 'day' THEN json_object('_tag', 'Day', 'date', s.plan_date)
        WHEN 'slot' THEN json_object('_tag', 'Slot', 'date', s.plan_date,
          'start', s.plan_start, 'minutes', s.plan_minutes)
        ELSE json_object('_tag', 'None')
      END AS plan,
      s.planned_at,
      CASE s.due_kind
        WHEN 'date' THEN json_object('date', s.due_date, 'by', json_object('_tag', 'User'))
        WHEN 'cleared' THEN NULL
        ELSE (SELECT json_object('date', json_extract(topic.value, '$.due.date'),
            'by', json_object('_tag', 'Ai', 'seq', json_extract(topic.value, '$.due.seq')))
          FROM (SELECT topics FROM digest WHERE digest.conversation_id = c.id
              ORDER BY digest.from_seq DESC, digest.id DESC LIMIT 1) latest,
            json_each(latest.topics) topic
          WHERE json_extract(topic.value, '$.due.date') IS NOT NULL
          ORDER BY json_extract(topic.value, '$.due.date'), json_extract(topic.value, '$.due.seq')
          LIMIT 1)
      END AS due
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

const decodeOpenTargets = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ label: Schema.String, link: Schema.String })),
);

export const openTarget = Effect.fnUntraced(function* (conversationId: ConversationId) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeOpenTargets(
      yield* sql`SELECT stream.open_label AS label, item.link AS link FROM item
        JOIN stream ON stream.id = item.stream_id
        WHERE item.conversation_id = ${conversationId}
          AND item.deleted_at IS NULL AND item.link IS NOT NULL
        ORDER BY item.seq DESC LIMIT 1`,
    ),
  );
});

const decodeSourcedItems = Schema.decodeUnknownEffect(Schema.Array(SourcedItemRow));

export const getItem = Effect.fnUntraced(function* (seq: Seq) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeSourcedItems(
      yield* sql`SELECT item.*, conversation.source_id, conversation.key AS conversation_key FROM item
        JOIN conversation ON conversation.id = item.conversation_id
        WHERE item.seq = ${seq}`,
    ),
  );
});
const decodeConversationIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: ConversationId })),
);

export type LiveItemsQuery =
  | { readonly conversationIds: ReadonlyArray<ConversationId> }
  | { readonly seqs: ReadonlyArray<Seq> }
  | { readonly sourceId: string; readonly threads: ReadonlyArray<string> };

export const liveItems = Effect.fnUntraced(function* (query: LiveItemsQuery) {
  const sql = yield* SqlClient.SqlClient;
  const selected =
    "seqs" in query
      ? sql.in("item.seq", query.seqs)
      : "conversationIds" in query
        ? sql.in("item.conversation_id", query.conversationIds)
        : sql`conversation.source_id = ${query.sourceId}
            AND coalesce(thread_id, container_id) IN ${sql.in(query.threads)}`;
  return yield* decodeSourcedItems(
    yield* sql`SELECT item.*, conversation.source_id, conversation.key AS conversation_key FROM item
      JOIN conversation ON conversation.id = item.conversation_id
      WHERE item.deleted_at IS NULL AND ${selected}
      ORDER BY item.conversation_id, item.seq`,
  );
});

const decodeThreads = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ sourceId: Schema.String, thread: Schema.String })),
);

export const threads = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeThreads(
    yield* sql`SELECT DISTINCT conversation.source_id, coalesce(thread_id, container_id) AS thread
      FROM item JOIN conversation ON conversation.id = item.conversation_id
      WHERE item.deleted_at IS NULL
      ORDER BY 1, 2`,
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

const decodeStreams = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...StreamRow.fields, items: Schema.Int })),
);

export const streams = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeStreams(
    yield* sql`SELECT stream.*, coalesce(live.items, 0) AS items FROM stream
      LEFT JOIN (SELECT stream_id, count(*) AS items FROM item WHERE deleted_at IS NULL
        GROUP BY stream_id) live ON live.stream_id = stream.id
      ORDER BY stream.source_id, stream.id`,
  );
});

const decodeConversationTitles = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: ConversationId, title: Schema.String })),
);

export const conversationTitles = Effect.fnUntraced(function* (ids: ReadonlyArray<ConversationId>) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeConversationTitles(
    yield* sql`SELECT id, title FROM conversation WHERE ${sql.in("id", ids)}`,
  );
  return new Map(rows.map(({ id, title }) => [id, title]));
});

export const AiStateCount = Schema.Struct({ ...AiStateRow.fields, conversations: Schema.Int });
export type AiStateCount = typeof AiStateCount.Type;

const decodeAiStates = Schema.decodeUnknownEffect(Schema.Array(AiStateCount));

export const aiStates = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeAiStates(
    yield* sql`SELECT ai_state.kind, ai_state.name, ai_state.ai_since,
        count(conversation_ai.conversation_id) AS conversations
      FROM ai_state LEFT JOIN conversation_ai
        ON conversation_ai.kind = ai_state.kind AND conversation_ai.name = ai_state.name
      GROUP BY ai_state.kind, ai_state.name
      ORDER BY ai_state.kind, ai_state.name`,
  );
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
        : query._tag === "Planned"
          ? sql`c.state = 'planned'`
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
        (SELECT json_object('name', pick.from_name, 'address', pick.from_address,
            'me', json(iif(pick.from_me, 'true', 'false')),
            'verified', json(iif((SELECT sum(other.from_verified) = count(*) FROM item other
              WHERE other.conversation_id = c.id AND other.deleted_at IS NULL
                AND lower(other.from_address) = lower(pick.from_address)), 'true', 'false')))
          FROM (SELECT item.from_name, item.from_address, item.from_me FROM item
            WHERE item.conversation_id = c.id AND item.deleted_at IS NULL
            ORDER BY item.from_me, item.seq DESC LIMIT 1) AS pick) AS "from",
        (SELECT json_group_array(json_object('name', name, 'address', address,
            'me', json(iif(me, 'true', 'false')), 'verified', json(iif(verified, 'true', 'false'))))
          FROM
          (SELECT item.from_name AS name, item.from_address AS address, item.from_me AS me,
              sum(item.from_verified) = count(*) AS verified, min(item.seq) AS first_seq
            FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL
            GROUP BY lower(item.from_address) ORDER BY first_seq LIMIT ${rowSenders})) AS senders,
        last.from_name AS last_from_name,
        last.from_address AS last_from_address,
        last.from_me AS last_from_me,
        last.text_new AS last_text_new,
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

const decodePlannedDues = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ due: Schema.NullOr(CalendarDate) })),
);

export const plannedDues = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodePlannedDues(
    yield* sql`WITH ${listed(sql)}
      SELECT json_extract(due, '$.date') AS due FROM listed
      WHERE state = 'planned'
      ORDER BY due, id`,
  );
});

export const UnreadSender = Schema.Struct({
  tag: Schema.NullOr(Schema.String),
  source: Schema.String,
  name: Schema.String,
  address: Schema.String,
  verified: Schema.BooleanFromBit,
});
export type UnreadSender = typeof UnreadSender.Type;

const decodeUnreadSenders = Schema.decodeUnknownEffect(Schema.Array(UnreadSender));

export const unreadSenders = Effect.fnUntraced(function* (perTag: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeUnreadSenders(
    yield* sql`WITH ${listed(sql)},
      latest AS (
        SELECT listed.id AS conversation_id, listed.source_id AS source, item.from_name AS name,
          item.from_address AS address, item.occurred_at AS at,
          row_number() OVER (PARTITION BY listed.id ORDER BY item.seq DESC) AS position
        FROM listed
        JOIN item ON item.conversation_id = listed.id AND item.deleted_at IS NULL
          AND item.from_me = 0
        WHERE listed.state = 'unread'
      ),
      sender AS (
        SELECT conversation_tag.tag, latest.source, latest.name, latest.address,
          (SELECT sum(other.from_verified) = count(*) FROM item other
            WHERE other.conversation_id = latest.conversation_id AND other.deleted_at IS NULL
              AND lower(other.from_address) = lower(latest.address)) AS verified,
          max(latest.at) AS at
        FROM latest
        LEFT JOIN conversation_tag ON conversation_tag.conversation_id = latest.conversation_id
        WHERE latest.position = 1
        GROUP BY conversation_tag.tag, lower(latest.address)
      ),
      ranked AS (
        SELECT *, row_number() OVER (PARTITION BY tag ORDER BY at DESC, address) AS rank FROM sender
      )
      SELECT tag, source, name, address, verified FROM ranked WHERE rank <= ${perTag}
      ORDER BY tag, rank`,
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
    yield* sql`SELECT seq, occurred_at, length(text_new) AS chars FROM item
      WHERE conversation_id = ${conversationId} AND deleted_at IS NULL AND kind IS NOT 'event'
      ORDER BY seq`,
  );
});

const decodeAiSince = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ aiSince: Schema.NullOr(UtcIso) })]),
);

export const aiSince = Effect.fnUntraced(function* (conversationId: ConversationId) {
  const sql = yield* SqlClient.SqlClient;
  const [{ aiSince }] = yield* decodeAiSince(
    yield* sql`SELECT min(ai_since) AS ai_since FROM conversation_ai
      WHERE conversation_id = ${conversationId}`,
  );
  return Option.fromNullOr(aiSince);
});

export const aiConversations = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeConversationIds(
    yield* sql`SELECT DISTINCT conversation_id AS id FROM conversation_ai ORDER BY id`,
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
  textNew: Schema.String,
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
        item.text_new, stream.name AS stream_name
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

const decodeEventDetails = Schema.decodeUnknownEffect(Schema.Array(EventDetailRow));

export const eventDetails = Effect.fnUntraced(function* (seqs: ReadonlyArray<Seq>) {
  if (seqs.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeEventDetails(
    yield* sql`SELECT * FROM event_detail WHERE ${sql.in("item_seq", seqs)} ORDER BY item_seq`,
  );
});

const decodeOccurrences = Schema.decodeUnknownEffect(Schema.Array(EventOccurrenceRow));

export const priorEvents = Effect.fnUntraced(function* (
  stream: StreamRow,
  events: ReadonlyArray<RawEvent>,
) {
  if (events.length === 0) return noPriors;
  const sql = yield* SqlClient.SqlClient;
  const ids = [
    ...new Set(
      events.flatMap(({ eventId, seriesId }) =>
        seriesId === null ? [eventId] : [eventId, seriesId],
      ),
    ),
  ];
  const details = yield* decodeEventDetails(
    yield* sql`SELECT event_detail.* FROM event_detail
      JOIN item ON item.seq = event_detail.item_seq
      WHERE item.stream_id = ${stream.id} AND item.deleted_at IS NULL
        AND ${sql.in("event_detail.event_id", ids)}
      ORDER BY event_detail.item_seq`,
  );
  const cancelled = events.filter(({ status }) => status === "cancelled");
  const occurrences =
    cancelled.length === 0
      ? []
      : yield* decodeOccurrences(
          yield* sql`SELECT * FROM event_occurrence WHERE source_id = ${stream.sourceId}
            AND ${sql.in(
              "event_id",
              cancelled.map(({ eventId }) => eventId),
            )}`,
        );
  return {
    details: new Map(details.map((row) => [row.eventId, row])),
    occurrences: new Map(occurrences.map((row) => [row.eventId, row])),
  } satisfies EventPriors;
});

export const eventOnly = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
) {
  if (conversationIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeConversationIds(
    yield* sql`SELECT id FROM conversation c WHERE ${sql.in("c.id", conversationIds)}
      AND NOT EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id
        AND item.deleted_at IS NULL AND item.kind IS NOT 'event')
      ORDER BY id`,
  );
  return rows.map(({ id }) => id);
});

const decodeMeetings = Schema.decodeUnknownEffect(Schema.Array(MeetingRow));

export const meetings = Effect.fnUntraced(function* (from: DateTime.Utc, to: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  const start = yield* Schema.encodeEffect(UtcIso)(from);
  const end = yield* Schema.encodeEffect(UtcIso)(to);
  return yield* decodeMeetings(
    yield* sql`WITH live AS (
        SELECT event_detail.*, item.conversation_id, item.title, conversation.source_id,
          row_number() OVER (PARTITION BY conversation.source_id, event_detail.event_id
            ORDER BY event_detail.item_seq DESC) AS position
        FROM event_detail
        JOIN item ON item.seq = event_detail.item_seq AND item.deleted_at IS NULL
        JOIN conversation ON conversation.id = item.conversation_id
      ),
      latest AS (SELECT * FROM live WHERE position = 1),
      series AS (
        SELECT source_id, series_id, max(item_seq) AS item_seq FROM live
        WHERE series_id IS NOT NULL GROUP BY source_id, series_id
      )
      SELECT conversation_id, item_seq, event_id, series_id,
        coalesce(title, (SELECT titled.title FROM live titled
          WHERE titled.source_id = latest.source_id AND titled.event_id = latest.event_id
            AND titled.title IS NOT NULL ORDER BY titled.item_seq DESC LIMIT 1), '') AS title,
        start_at, end_at, start_utc, end_utc, all_day, location, status, change, 0 AS recurring
      FROM latest
      WHERE series_id IS NULL AND end_utc >= ${start} AND start_utc <= ${end}
      UNION ALL
      SELECT coalesce(exception.conversation_id, master.conversation_id, series_item.conversation_id)
          AS conversation_id,
        coalesce(exception.item_seq, master.item_seq, series.item_seq) AS item_seq,
        occurrence.event_id,
        occurrence.series_id,
        coalesce(exception.title, master.title, series_item.title, '') AS title,
        occurrence.start_at, occurrence.end_at, occurrence.start_utc, occurrence.end_utc,
        occurrence.all_day,
        CASE WHEN exception.event_id IS NOT NULL THEN exception.location ELSE master.location END
          AS location,
        occurrence.status, coalesce(exception.change, 'null') AS change, 1 AS recurring
      FROM event_occurrence occurrence
      JOIN series ON series.source_id = occurrence.source_id
        AND series.series_id = occurrence.series_id
      JOIN item series_item ON series_item.seq = series.item_seq
      LEFT JOIN latest exception ON exception.source_id = occurrence.source_id
        AND exception.series_id = occurrence.series_id
        AND exception.event_id = occurrence.event_id
      LEFT JOIN latest master ON master.source_id = occurrence.source_id
        AND master.event_id = occurrence.series_id
      WHERE occurrence.status = 'confirmed'
        AND coalesce(exception.status, 'confirmed') = 'confirmed'
        AND coalesce(master.status, 'confirmed') = 'confirmed'
        AND occurrence.end_utc >= ${start} AND occurrence.start_utc <= ${end}
      ORDER BY start_utc, item_seq`,
  );
});

const decodeFaces = Schema.decodeUnknownEffect(Schema.Array(FaceRow));

export const face = Effect.fnUntraced(function* (sourceId: string, address: string) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeFaces(
      yield* sql`SELECT hash, kind, fetched_at FROM face
        WHERE source_id = ${sourceId} AND address = ${address}`,
    ),
  );
});

const decodeFaceBlobs = Schema.decodeUnknownEffect(Schema.Array(FaceBlobRow));

export const faceBlob = Effect.fnUntraced(function* (hash: FaceHash) {
  const sql = yield* SqlClient.SqlClient;
  return Arr.head(
    yield* decodeFaceBlobs(yield* sql`SELECT mime, bytes FROM face_blob WHERE hash = ${hash}`),
  );
});
