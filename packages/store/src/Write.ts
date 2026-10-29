import type { RawItem, StreamDescriptor } from "@weir/contract/Source";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import * as Read from "./Read.ts";
import {
  ConversationId,
  ConversationStateRow,
  ConversationTagRow,
  type DigestId,
  DigestInsert,
  DigestRow,
  DigestRunInsert,
  ItemInsert,
  Seq,
  StreamId,
  StreamInsert,
  StreamRow,
  SyncRunInsert,
  TagStateRow,
  UtcIso,
} from "./Rows.ts";

export type StoredItem = RawItem & { readonly bodyNew: string };

export interface WrittenItem {
  readonly seq: Seq;
  readonly conversationId: ConversationId;
  readonly previousConversationId: ConversationId | null;
}

const decodeStreamIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: StreamId })));
const decodeStream = Schema.decodeUnknownEffect(Schema.Tuple([StreamRow]));
const decodeConversationId = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ id: ConversationId })]),
);
const decodeConversationIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: ConversationId })),
);
const decodeSeq = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ seq: Seq })]));
const decodeStreams = Schema.decodeUnknownEffect(Schema.Array(StreamRow));
const decodeAddresses = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ fromAddress: Schema.String })),
);
const decodeItemRefs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Seq, conversationId: ConversationId })),
);
const encodeTags = Schema.encodeEffect(Schema.Array(ConversationTagRow));
const encodeStates = Schema.encodeEffect(Schema.Array(ConversationStateRow));
const encodeTagStates = Schema.encodeEffect(Schema.Array(TagStateRow));

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
      if (!previous.some((old) => ownAddresses(old).symmetricDifference(me).size > 0)) {
        return { stream, fromMeChanged: [] };
      }
      const addresses = yield* decodeAddresses(
        yield* sql`SELECT DISTINCT from_address FROM item WHERE stream_id = ${stream.id}`,
      );
      const mine = addresses
        .map(({ fromAddress }) => fromAddress)
        .filter((address) => me.has(address.toLowerCase()));
      const changed = yield* decodeConversationIds(
        yield* sql`UPDATE item SET from_me = (${sql.in("from_address", mine)})
          WHERE stream_id = ${stream.id} AND from_me IS NOT (${sql.in("from_address", mine)})
          RETURNING conversation_id AS id`,
      );
      return { stream, fromMeChanged: [...new Set(changed.map(({ id }) => id))] };
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
          const previousConversationId = prior[0]?.conversationId ?? null;
          touched.add(conversationId);
          if (previousConversationId !== null) touched.add(previousConversationId);
          return { seq, conversationId, previousConversationId } satisfies WrittenItem;
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

export const addConversationTags = Effect.fnUntraced(function* (
  rows: ReadonlyArray<ConversationTagRow>,
) {
  if (rows.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO conversation_tag ${sql.insert(yield* encodeTags(rows))}
    ON CONFLICT (conversation_id, tag) DO NOTHING`;
});

export const replaceConversationTags = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
  rows: ReadonlyArray<ConversationTagRow>,
) {
  if (conversationIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM conversation_tag WHERE ${sql.in("conversation_id", conversationIds)}`;
  yield* addConversationTags(rows);
});

export const advanceSeenSeq = Effect.fnUntraced(function* (
  seen: ReadonlyArray<{ readonly conversationId: ConversationId; readonly seq: Seq }>,
) {
  if (seen.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* encodeStates(
    seen.map(({ conversationId, seq }) => ({
      conversationId,
      seenSeq: seq,
      clearedSeq: Seq.make(0),
      muted: false,
    })),
  );
  yield* sql`INSERT INTO conversation_state ${sql.insert(rows)}
    ON CONFLICT (conversation_id) DO UPDATE SET
      seen_seq = max(conversation_state.seen_seq, excluded.seen_seq)`;
});

export type StateChange =
  | { readonly _tag: "Read"; readonly seq: Seq }
  | { readonly _tag: "Unread"; readonly seq?: Seq }
  | { readonly _tag: "Done"; readonly seq: Seq }
  | { readonly _tag: "Mute" }
  | { readonly _tag: "Restore" };

const stateAssignments = (sql: SqlClient.SqlClient, change: StateChange) => {
  const last = sql`conversation.last_seq`;
  switch (change._tag) {
    case "Read":
      return sql`seen_seq = max(seen_seq, min(${change.seq}, ${last}))`;
    case "Unread":
      return sql`seen_seq = max(0, min(${change.seq ?? last}, ${last}) - 1)`;
    case "Done":
      return sql`cleared_seq = max(cleared_seq, min(${change.seq}, ${last}))`;
    case "Mute":
      return sql`muted = 1`;
    case "Restore":
      return sql`muted = 0, cleared_seq = 0, seen_seq = max(seen_seq, ${last})`;
  }
};

export const changeState = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
  change: StateChange,
) {
  if (conversationIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO conversation_state (conversation_id, seen_seq, cleared_seq, muted)
        SELECT id, 0, 0, 0 FROM conversation WHERE ${sql.in("id", conversationIds)}
        ON CONFLICT (conversation_id) DO NOTHING`;
      yield* sql`UPDATE conversation_state SET ${stateAssignments(sql, change)}
        FROM conversation
        WHERE conversation.id = conversation_state.conversation_id
          AND ${sql.in("conversation_state.conversation_id", conversationIds)}`;
    }),
  );
});

export const clear = Effect.fnUntraced(function* (view: Read.TagFilter, seq: Seq) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const ids = (yield* Read.conversations(view)).map(({ id }) => id);
      yield* changeState(ids, { _tag: "Done", seq });
      const after = yield* Read.conversations({ _tag: "Ids", ids });
      return after.filter(({ state }) => state === "done").length;
    }),
  );
});

export const saveCursor = Effect.fnUntraced(function* (
  streamId: StreamId,
  cursor: string,
  { backfilled }: { readonly backfilled: boolean },
) {
  const sql = yield* SqlClient.SqlClient;
  const backfilledAt = backfilled ? yield* Schema.encodeEffect(UtcIso)(yield* DateTime.now) : null;
  yield* sql`UPDATE stream SET
      cursor = ${cursor},
      backfilled_at = coalesce(backfilled_at, ${backfilledAt})
    WHERE id = ${streamId}`;
});

export const recordSyncRun = Effect.fnUntraced(function* (run: SyncRunInsert) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* Schema.encodeEffect(SyncRunInsert)(run);
  yield* sql`INSERT INTO sync_run ${sql.insert(row)}`;
  yield* sql`UPDATE stream SET last_sync_at = ${row.startedAt}, last_error = ${row.error}
    WHERE id = ${row.streamId}`;
});

export const recordSourceFailure = Effect.fnUntraced(function* (
  sourceId: string,
  run: Omit<SyncRunInsert, "streamId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const streams = yield* decodeStreamIds(
    yield* sql`SELECT id FROM stream WHERE source_id = ${sourceId} ORDER BY id`,
  );
  yield* Effect.forEach(streams, ({ id }) => recordSyncRun({ ...run, streamId: id }), {
    discard: true,
  });
});

export const reconcileTagState = Effect.fnUntraced(function* (aiTags: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM tag_state WHERE NOT ${sql.in("name", aiTags)}`;
  if (aiTags.length === 0) return;
  const aiSince = yield* DateTime.now;
  const rows = yield* encodeTagStates(aiTags.map((name) => ({ name, aiSince })));
  yield* sql`INSERT INTO tag_state ${sql.insert(rows)} ON CONFLICT (name) DO NOTHING`;
});

export const recordDigestRun = Effect.fnUntraced(function* (run: DigestRunInsert) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO digest_run ${sql.insert(yield* Schema.encodeEffect(DigestRunInsert)(run))}`;
});

const decodeDigest = Schema.decodeUnknownEffect(Schema.Tuple([DigestRow]));

export const writeDigest = Effect.fnUntraced(function* (
  digest: DigestInsert,
  run: DigestRunInsert,
  replaces: DigestId | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* Schema.encodeEffect(DigestInsert)(digest);
  const text = [digest.headline, ...digest.topics.flatMap(({ title, body }) => [title, body])].join(
    "\n",
  );
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [written] = yield* decodeDigest(
        yield* sql`INSERT INTO digest ${sql.insert(row)} RETURNING *`,
      );
      yield* sql`INSERT INTO search_fts (rowid, text, conversation_id, item_seq, digest_id)
        VALUES (${-written.id}, ${text}, ${written.conversationId}, NULL, ${written.id})`;
      if (replaces !== null) {
        yield* sql`DELETE FROM digest WHERE id = ${replaces}`;
        yield* sql`DELETE FROM search_fts WHERE rowid = ${-replaces}`;
      }
      yield* recordDigestRun(run);
      return written;
    }),
  );
});
