import { groupKeyPrefix } from "@weir/contract/Config";
import type { RawItem, StreamDescriptor, SyncPage } from "@weir/contract/Source";
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

export type StoredItem = RawItem & { readonly bodyNew: string; readonly key: string };

export interface ItemMove {
  readonly seq: Seq;
  readonly key: string;
}

export interface WrittenItem {
  readonly seq: Seq;
  readonly conversationId: ConversationId;
  readonly previousConversationId: ConversationId | null;
  readonly inserted: boolean;
  readonly conversationWasRead: boolean;
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
const decodeMoveRefs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Seq, conversationId: ConversationId, key: Schema.String })),
);
const decodeTarget = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ id: ConversationId, lastSeq: Schema.NullOr(Seq) })]),
);
const decodeWatermarks = Schema.decodeUnknownEffect(
  Schema.Tuple([
    Schema.Struct({
      lastSeq: Seq,
      seenSeq: Schema.NullOr(Seq),
      clearedSeq: Schema.NullOr(Seq),
    }),
  ]),
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
      title = CASE
        WHEN substr(key, 1, ${groupKeyPrefix.length}) = ${groupKeyPrefix}
          THEN substr(key, ${groupKeyPrefix.length + 1})
        ELSE coalesce(
          (SELECT title FROM item
            WHERE conversation_id = conversation.id AND deleted_at IS NULL AND title IS NOT NULL
            ORDER BY occurred_at, seq LIMIT 1),
          (SELECT container_name FROM item
            WHERE conversation_id = conversation.id AND deleted_at IS NULL
            ORDER BY occurred_at, seq LIMIT 1)
        )
      END,
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

export const moveItems = Effect.fnUntraced(function* (
  sourceId: string,
  moves: ReadonlyArray<ItemMove>,
) {
  if (moves.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const keyOf = new Map(moves.map(({ seq, key }) => [seq, key]));
      const current = yield* decodeMoveRefs(
        yield* sql`SELECT item.seq, item.conversation_id, conversation.key FROM item
          JOIN conversation ON conversation.id = item.conversation_id
          WHERE ${sql.in("item.seq", [...keyOf.keys()])}`,
      );
      const byKey = new Map<string, Array<Seq>>();
      const from = new Set<ConversationId>();
      for (const { seq, conversationId, key } of current) {
        const target = keyOf.get(seq);
        if (target === undefined || target === key) continue;
        from.add(conversationId);
        const seqs = byKey.get(target);
        if (seqs === undefined) byKey.set(target, [seq]);
        else seqs.push(seq);
      }
      if (byKey.size === 0) return [];
      const targets = yield* Effect.forEach([...byKey], ([key, seqs]) =>
        Effect.gen(function* () {
          const [target] = yield* decodeTarget(
            yield* sql`INSERT INTO conversation (source_id, key) VALUES (${sourceId}, ${key})
              ON CONFLICT (source_id, key) DO UPDATE SET key = excluded.key
              RETURNING id, last_seq`,
          );
          yield* sql`UPDATE item SET conversation_id = ${target.id} WHERE ${sql.in("seq", seqs)}`;
          return target;
        }),
      );
      yield* indexItems(sql.in("item.seq", [...byKey.values()].flat()));
      const to = targets.map(({ id }) => id);
      yield* recomputeConversations([...from, ...to]);
      yield* Effect.forEach(
        targets,
        ({ id, lastSeq: lastBefore }) =>
          Effect.gen(function* () {
            const [now] = yield* decodeWatermarks(
              yield* sql`SELECT c.last_seq, s.seen_seq, s.cleared_seq FROM conversation c
                LEFT JOIN conversation_state s ON s.conversation_id = c.id
                WHERE c.id = ${id}`,
            );
            const caughtUp = (watermark: Seq | null) =>
              (watermark ?? 0) >= (lastBefore ?? 0) ? now.lastSeq : (watermark ?? Seq.make(0));
            const rows = yield* encodeStates([
              {
                conversationId: id,
                seenSeq: caughtUp(now.seenSeq),
                clearedSeq: caughtUp(now.clearedSeq),
                muted: false,
              },
            ]);
            yield* sql`INSERT INTO conversation_state ${sql.insert(rows)}
              ON CONFLICT (conversation_id) DO UPDATE SET
                seen_seq = excluded.seen_seq,
                cleared_seq = excluded.cleared_seq`;
          }),
        { discard: true },
      );
      return [...new Set([...from, ...to])];
    }),
  );
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
      const unreadBefore = new Set(
        (yield* decodeConversationIds(
          yield* sql`SELECT c.id FROM conversation c
            LEFT JOIN conversation_state s ON s.conversation_id = c.id
            WHERE c.source_id = ${stream.sourceId}
              AND ${sql.in(
                "c.key",
                latest.map(({ key }) => key),
              )}
              AND c.last_seq > coalesce(s.seen_seq, 0)
              AND EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL)`,
        )).map(({ id }) => id),
      );
      const touched = new Set<ConversationId>();
      const written = yield* Effect.forEach(latest, (item) =>
        Effect.gen(function* () {
          const prior = yield* decodeItemRefs(
            yield* sql`SELECT seq, conversation_id FROM item
              WHERE stream_id = ${stream.id} AND external_id = ${item.externalId}`,
          );
          const [{ id: conversationId }] = yield* decodeConversationId(
            yield* sql`INSERT INTO conversation (source_id, key)
              VALUES (${stream.sourceId}, ${item.key})
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
          return {
            seq,
            conversationId,
            previousConversationId,
            inserted: prior.length === 0,
            conversationWasRead: !unreadBefore.has(conversationId),
          } satisfies WrittenItem;
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

interface StateSnapshot {
  readonly conversationId: number;
  readonly seenSeq: number;
  readonly clearedSeq: number;
  readonly muted: number;
}

const stateKey = ({ seenSeq, clearedSeq, muted }: StateSnapshot) =>
  `${seenSeq}:${clearedSeq}:${muted}`;

export const changeState = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
  change: StateChange,
) {
  if (conversationIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO conversation_state (conversation_id, seen_seq, cleared_seq, muted)
        SELECT id, 0, 0, 0 FROM conversation WHERE ${sql.in("id", conversationIds)}
        ON CONFLICT (conversation_id) DO NOTHING`;
      const before = new Map(
        (yield* sql<StateSnapshot>`SELECT conversation_id, seen_seq, cleared_seq, muted
          FROM conversation_state
          WHERE ${sql.in("conversation_id", conversationIds)}`).map((row) => [
          row.conversationId,
          stateKey(row),
        ]),
      );
      const after = yield* sql<StateSnapshot>`UPDATE conversation_state
        SET ${stateAssignments(sql, change)}
        FROM conversation
        WHERE conversation.id = conversation_state.conversation_id
          AND ${sql.in("conversation_state.conversation_id", conversationIds)}
        RETURNING conversation_id, seen_seq, cleared_seq, muted`;
      return after
        .filter((row) => before.get(row.conversationId) !== stateKey(row))
        .map((row) => ConversationId.make(row.conversationId))
        .sort((left, right) => left - right);
    }),
  );
});

export const clear = Effect.fnUntraced(function* (view: Read.TagFilter, seq: Seq) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const ids = (yield* Read.conversations(view)).map(({ id }) => id);
      const changed = yield* changeState(ids, { _tag: "Done", seq });
      const after = yield* Read.conversations({ _tag: "Ids", ids });
      return { cleared: after.filter(({ state }) => state === "done").length, changed };
    }),
  );
});

export const saveCursor = Effect.fnUntraced(function* (
  streamId: StreamId,
  cursor: string,
  backfill: SyncPage["backfill"],
) {
  const sql = yield* SqlClient.SqlClient;
  const backfilledAt =
    backfill === "done"
      ? sql`coalesce(backfilled_at, ${yield* Schema.encodeEffect(UtcIso)(yield* DateTime.now)})`
      : sql`NULL`;
  yield* sql`UPDATE stream SET cursor = ${cursor}, backfilled_at = ${backfilledAt}
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
