import type { RawItem, StreamDescriptor } from "@weir/contract/Source";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import {
  ConversationId,
  ItemInsert,
  Seq,
  type StreamId,
  StreamInsert,
  StreamRow,
  UtcIso,
} from "./Rows.ts";

export type StoredItem = RawItem & { readonly bodyNew: string };

export interface WrittenItem {
  readonly seq: Seq;
  readonly conversationId: ConversationId;
  readonly inserted: boolean;
}

const decodeStream = Schema.decodeUnknownEffect(Schema.Tuple([StreamRow]));
const decodeConversationId = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ id: ConversationId })]),
);
const decodeSeq = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ seq: Seq })]));
const decodeStreams = Schema.decodeUnknownEffect(Schema.Array(StreamRow));
const decodeAddresses = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ fromAddress: Schema.String })),
);
const decodeItemRefs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Seq, conversationId: ConversationId })),
);

const ownAddresses = (stream: StreamRow) =>
  new Set(stream.me.map((address) => address.toLowerCase()));

const indexItems = Effect.fnUntraced(function* (items: Statement.Fragment) {
  const sql = yield* SqlClient.SqlClient;
  // FTS5 cannot filter UNINDEXED columns without a full scan, so an item's row is keyed by rowid = seq.
  yield* sql`DELETE FROM search_fts WHERE rowid IN (SELECT seq FROM item WHERE ${items})`;
  yield* sql`INSERT INTO search_fts (rowid, text, conversation_id, item_seq, digest_id)
    SELECT item.seq,
      concat_ws(char(10), item.title, item.from_name, item.from_address, stream.name, item.body_new),
      item.conversation_id,
      item.seq,
      NULL
    FROM item JOIN stream ON stream.id = item.stream_id
    WHERE item.deleted_at IS NULL AND ${items}`;
});

export const upsertStream = Effect.fnUntraced(function* (
  sourceId: string,
  descriptor: StreamDescriptor,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* Schema.encodeEffect(StreamInsert)({
    sourceId,
    externalId: descriptor.id,
    kind: descriptor.kind,
    name: descriptor.name,
    openLabel: descriptor.openLabel,
    me: descriptor.me,
    cursor: null,
    backfilledAt: null,
    lastSyncAt: null,
    lastError: null,
  });
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const previous = yield* decodeStreams(
        yield* sql`SELECT * FROM stream
          WHERE source_id = ${sourceId} AND external_id = ${descriptor.id}`,
      );
      const [stream] = yield* decodeStream(
        yield* sql`INSERT INTO stream ${sql.insert(row)}
          ON CONFLICT (source_id, external_id) DO UPDATE SET
            kind = excluded.kind,
            name = excluded.name,
            open_label = excluded.open_label,
            me = excluded.me
          RETURNING *`,
      );
      if (previous.some(({ name }) => name !== stream.name)) {
        yield* indexItems(sql`item.stream_id = ${stream.id}`);
      }
      const me = ownAddresses(stream);
      if (previous.some((old) => ownAddresses(old).symmetricDifference(me).size > 0)) {
        const addresses = yield* decodeAddresses(
          yield* sql`SELECT DISTINCT from_address FROM item WHERE stream_id = ${stream.id}`,
        );
        const mine = addresses
          .map(({ fromAddress }) => fromAddress)
          .filter((address) => me.has(address.toLowerCase()));
        yield* sql`UPDATE item SET from_me = (${sql.in("from_address", mine)})
          WHERE stream_id = ${stream.id}`;
      }
      return stream;
    }),
  );
});

const recomputeConversations = Effect.fnUntraced(function* (ids: ReadonlyArray<ConversationId>) {
  if (ids.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE conversation SET
      title = coalesce(
        (SELECT title FROM item
          WHERE conversation_id = conversation.id AND deleted_at IS NULL AND title IS NOT NULL
          ORDER BY occurred_at, seq LIMIT 1),
        (SELECT container_name FROM item
          WHERE conversation_id = conversation.id AND deleted_at IS NULL
          ORDER BY occurred_at, seq LIMIT 1)
      ),
      first_at = live.first_at,
      last_at = live.last_at,
      last_seq = live.last_seq
    FROM (
      SELECT conversation_id,
        min(occurred_at) AS first_at,
        max(occurred_at) AS last_at,
        max(seq) AS last_seq
      FROM item
      WHERE deleted_at IS NULL AND ${sql.in("conversation_id", ids)}
      GROUP BY conversation_id
    ) AS live
    WHERE conversation.id = live.conversation_id`;
});

export const writeItems = Effect.fnUntraced(function* (
  stream: StreamRow,
  items: ReadonlyArray<StoredItem>,
) {
  const sql = yield* SqlClient.SqlClient;
  const syncedAt = yield* DateTime.now;
  const me = ownAddresses(stream);
  const latest = [...new Map(items.map((item) => [item.externalId, item])).values()];
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const touched = new Set<ConversationId>();
      const written = yield* Effect.forEach(latest, (item) =>
        Effect.gen(function* () {
          const prior = yield* decodeItemRefs(
            yield* sql`SELECT seq, conversation_id FROM item
              WHERE stream_id = ${stream.id} AND external_id = ${item.externalId}`,
          );
          const [{ id: conversationId }] = yield* decodeConversationId(
            yield* sql`INSERT INTO conversation (source_id, key)
              VALUES (${stream.sourceId}, ${item.threadId ?? item.containerId})
              ON CONFLICT (source_id, key) DO UPDATE SET key = excluded.key
              RETURNING id`,
          );
          const row = yield* Schema.encodeEffect(ItemInsert)({
            streamId: stream.id,
            externalId: item.externalId,
            kind: stream.kind,
            conversationId,
            threadId: item.threadId,
            containerId: item.containerId,
            containerName: item.containerName,
            occurredAt: DateTime.makeUnsafe(item.occurredAt),
            syncedAt,
            title: item.title,
            fromName: item.from.name,
            fromAddress: item.from.address,
            fromMe: me.has(item.from.address.toLowerCase()),
            body: item.body,
            bodyNew: item.bodyNew,
            link: item.link,
            raw: item.raw,
            deletedAt: null,
          });
          const [{ seq }] = yield* decodeSeq(
            yield* sql`INSERT INTO item ${sql.insert(row)}
              ON CONFLICT (stream_id, external_id) DO UPDATE SET
                kind = excluded.kind,
                conversation_id = excluded.conversation_id,
                thread_id = excluded.thread_id,
                container_id = excluded.container_id,
                container_name = excluded.container_name,
                occurred_at = excluded.occurred_at,
                synced_at = excluded.synced_at,
                title = excluded.title,
                from_name = excluded.from_name,
                from_address = excluded.from_address,
                from_me = excluded.from_me,
                body = excluded.body,
                body_new = excluded.body_new,
                link = excluded.link,
                raw = excluded.raw,
                deleted_at = excluded.deleted_at
              RETURNING seq`,
          );
          touched.add(conversationId);
          for (const { conversationId: previous } of prior) touched.add(previous);
          return { seq, conversationId, inserted: prior.length === 0 } satisfies WrittenItem;
        }),
      );
      yield* indexItems(
        sql.in(
          "item.seq",
          written.map(({ seq }) => seq),
        ),
      );
      yield* recomputeConversations([...touched]);
      return written;
    }),
  );
});

export const softDeleteItems = Effect.fnUntraced(function* (
  streamId: StreamId,
  externalIds: ReadonlyArray<string>,
) {
  if (externalIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const deletedAt = yield* Schema.encodeEffect(UtcIso)(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const deleted = yield* decodeItemRefs(
        yield* sql`UPDATE item SET deleted_at = ${deletedAt}
          WHERE stream_id = ${streamId} AND deleted_at IS NULL AND ${sql.in("external_id", externalIds)}
          RETURNING seq, conversation_id`,
      );
      if (deleted.length === 0) return [];
      yield* sql`DELETE FROM search_fts WHERE ${sql.in(
        "rowid",
        deleted.map(({ seq }) => seq),
      )}`;
      const conversationIds = [...new Set(deleted.map(({ conversationId }) => conversationId))];
      yield* recomputeConversations(conversationIds);
      return conversationIds;
    }),
  );
});
