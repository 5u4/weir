import { derive } from "@weir/body/Body";
import { groupKeyPrefix, groupNameOf } from "@weir/contract/Config";
import {
  type BodyFormat,
  FaceKind,
  type RawItem,
  type SeriesOccurrences,
  type StreamDescriptor,
  type SyncPage,
} from "@weir/contract/Source";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { type EventDraft, type EventPriors, eventDraft, utcOf } from "./Events.ts";
import * as Read from "./Read.ts";
import {
  AiKind,
  type AiScope,
  AiStateRow,
  ConversationId,
  ConversationStateRow,
  ConversationTagRow,
  type DigestId,
  DigestInsert,
  DigestRow,
  DigestRunInsert,
  type DueOverride,
  EventDetailRow,
  EventOccurrenceRow,
  FaceHash,
  type FaceOutcome,
  ItemInsert,
  type Plan,
  Seq,
  StreamId,
  StreamInsert,
  StreamRow,
  SyncRunInsert,
  UtcIso,
} from "./Rows.ts";

declare const drafted: unique symbol;

export interface ItemDraft {
  readonly sourceId: string;
  readonly externalId: string;
  readonly threadId: string | null;
  readonly containerId: string;
  readonly containerName: string;
  readonly occurredAt: string;
  readonly title: string | null;
  readonly fromName: string;
  readonly fromAddress: string;
  readonly fromMe: boolean;
  readonly fromVerified: boolean;
  readonly format: BodyFormat;
  readonly bodyNew: string;
  readonly text: string;
  readonly textNew: string;
  readonly link: string | null;
  readonly raw: unknown;
  readonly event: EventDraft | null;
  readonly refresh: Seq | null;
  readonly [drafted]: true;
}

export type StoredItem = ItemDraft & { readonly key: string };

export interface ItemMove {
  readonly seq: Seq;
  readonly key: string;
  readonly quiet: boolean;
}

export interface WrittenItem {
  readonly seq: Seq;
  readonly conversationId: ConversationId;
  readonly previousConversationId: ConversationId | null;
  readonly inserted: boolean;
  readonly conversationWasRead: boolean;
  readonly conversationWasDone: boolean;
  readonly conversationWasNew: boolean;
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
const decodeDeleted = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Seq, conversationId: ConversationId, thread: Schema.String })),
);
const decodeDigestIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: Schema.Number })),
);
const decodeMoveRefs = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Seq, conversationId: ConversationId, key: Schema.String })),
);
const decodeBounds = Schema.decodeUnknownEffect(
  Schema.Tuple([
    Schema.Struct({ minUnseen: Schema.NullOr(Seq), minUncleared: Schema.NullOr(Seq) }),
  ]),
);
const decodeSettled = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ settled: Schema.BooleanFromBit })]),
);
const decodeWatermarks = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ seenSeq: Seq, clearedSeq: Seq })]),
);
const encodeTags = Schema.encodeEffect(Schema.Array(ConversationTagRow));
const encodeStates = Schema.encodeEffect(Schema.Array(ConversationStateRow));
const encodeAiStates = Schema.encodeEffect(Schema.Array(AiStateRow));
const decodeConversationStates = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: ConversationId,
      unread: Schema.BooleanFromBit,
      done: Schema.BooleanFromBit,
    }),
  ),
);
const encodeEventDetail = Schema.encodeEffect(EventDetailRow);
const encodeOccurrences = Schema.encodeEffect(Schema.Array(EventOccurrenceRow));

const ownAddresses = (stream: StreamRow) =>
  new Set(stream.me.map((address) => address.toLowerCase()));

export const draft = (
  stream: StreamRow,
  item: RawItem,
  priors: EventPriors,
  live: boolean,
): ItemDraft | null => {
  const derived = derive(item);
  const outcome = item.event === undefined ? null : eventDraft(item.event, priors, live);
  if (item.event !== undefined && outcome === null) return null;
  return {
    sourceId: stream.sourceId,
    externalId: item.externalId,
    threadId: item.threadId,
    containerId: item.containerId,
    containerName: item.containerName,
    occurredAt: item.occurredAt,
    title: item.title,
    fromName: item.from.name,
    fromAddress: item.from.address,
    fromMe: ownAddresses(stream).has(item.from.address.toLowerCase()),
    fromVerified: item.fromVerified,
    format: item.format,
    ...derived,
    link: item.link,
    raw: item.raw,
    event: outcome?.event ?? null,
    refresh: outcome?._tag === "Refresh" ? outcome.itemSeq : null,
  } as ItemDraft;
};

const indexItems = Effect.fnUntraced(function* (items: Statement.Fragment) {
  const sql = yield* SqlClient.SqlClient;
  // FTS5 cannot filter UNINDEXED columns without a full scan, so an item's row is keyed by rowid = seq.
  yield* sql`DELETE FROM search_fts WHERE rowid IN (SELECT seq FROM item WHERE ${items})`;
  yield* sql`INSERT INTO search_fts (rowid, text, conversation_id, item_seq, digest_id)
    SELECT item.seq,
      concat_ws(char(10), item.title, item.from_name, item.from_address, stream.name, item.text_new),
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
    lastOkAt: null,
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
      const quiet = new Set(moves.filter((move) => move.quiet).map(({ seq }) => seq));
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
      const moving = [...byKey.values()].flat();
      const targets = yield* Effect.forEach([...byKey], ([key, seqs]) =>
        Effect.gen(function* () {
          const [target] = yield* decodeConversationId(
            yield* sql`INSERT INTO conversation (source_id, key) VALUES (${sourceId}, ${key})
              ON CONFLICT (source_id, key) DO UPDATE SET key = excluded.key
              RETURNING id`,
          );
          const [{ settled }] = yield* decodeSettled(
            yield* sql`SELECT EXISTS (SELECT 1 FROM item
                WHERE conversation_id = ${target.id} AND deleted_at IS NULL
                  AND NOT ${sql.in("seq", moving)}) AS settled`,
          );
          const counted = settled ? seqs.filter((seq) => !quiet.has(seq)) : seqs;
          const [bounds] = yield* decodeBounds(
            yield* sql`SELECT
                min(CASE WHEN item.seq > coalesce(s.seen_seq, 0) THEN item.seq END) AS min_unseen,
                min(CASE WHEN item.seq > coalesce(s.cleared_seq, 0) THEN item.seq END) AS min_uncleared
              FROM item LEFT JOIN conversation_state s ON s.conversation_id = item.conversation_id
              WHERE item.deleted_at IS NULL
                AND ((item.conversation_id = ${target.id} AND NOT ${sql.in("item.seq", moving)})
                  OR ${sql.in("item.seq", counted)})`,
          );
          yield* sql`UPDATE item SET conversation_id = ${target.id} WHERE ${sql.in("seq", seqs)}`;
          if (groupNameOf(key) !== null) {
            const dropped = yield* decodeDigestIds(
              yield* sql`DELETE FROM digest WHERE conversation_id = ${target.id}
                AND EXISTS (SELECT 1 FROM item WHERE ${sql.in("item.seq", seqs)}
                  AND item.seq BETWEEN digest.from_seq AND digest.to_seq)
                RETURNING id`,
            );
            if (dropped.length > 0) {
              yield* sql`DELETE FROM search_fts WHERE ${sql.in(
                "rowid",
                dropped.map(({ id }) => -id),
              )}`;
            }
          }
          return { id: target.id, ...bounds };
        }),
      );
      yield* indexItems(sql.in("item.seq", moving));
      const to = targets.map(({ id }) => id);
      yield* recomputeConversations([...from, ...to]);
      yield* Effect.forEach(
        targets,
        ({ id, minUnseen, minUncleared }) =>
          Effect.gen(function* () {
            const [marks] = yield* decodeWatermarks(
              yield* sql`SELECT
                  coalesce(max(CASE WHEN ${minUnseen} IS NULL OR seq < ${minUnseen} THEN seq END), 0)
                    AS seen_seq,
                  coalesce(max(CASE WHEN ${minUncleared} IS NULL OR seq < ${minUncleared} THEN seq END), 0)
                    AS cleared_seq
                FROM item WHERE conversation_id = ${id} AND deleted_at IS NULL`,
            );
            const rows = yield* encodeStates([{ conversationId: id, ...marks, muted: false }]);
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
  const latest = [...new Map(items.map((item) => [item.externalId, item])).values()];
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const before = new Map(
        (yield* decodeConversationStates(
          yield* sql`SELECT c.id,
              c.last_seq > coalesce(s.seen_seq, 0) AS unread,
              c.last_seq <= coalesce(s.cleared_seq, 0) AS done
            FROM conversation c
            LEFT JOIN conversation_state s ON s.conversation_id = c.id
            WHERE c.source_id = ${stream.sourceId}
              AND ${sql.in(
                "c.key",
                latest.map(({ key }) => key),
              )}
              AND EXISTS (SELECT 1 FROM item WHERE item.conversation_id = c.id AND item.deleted_at IS NULL)`,
        )).map(({ id, ...state }) => [id, state]),
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
            fromName: item.fromName,
            fromAddress: item.fromAddress,
            fromMe: item.fromMe,
            fromVerified: item.fromVerified,
            format: item.format,
            bodyNew: item.bodyNew,
            text: item.text,
            textNew: item.textNew,
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
                from_verified = excluded.from_verified,
                format = excluded.format,
                body_new = excluded.body_new,
                text = excluded.text,
                text_new = excluded.text_new,
                link = excluded.link,
                raw = excluded.raw,
                deleted_at = excluded.deleted_at
              RETURNING seq`,
          );
          if (item.event !== null) {
            const detail = yield* encodeEventDetail({ itemSeq: seq, ...item.event });
            yield* sql`INSERT INTO event_detail ${sql.insert(detail)}
              ON CONFLICT (item_seq) DO UPDATE SET
                event_id = excluded.event_id,
                series_id = excluded.series_id,
                recurring = excluded.recurring,
                start_at = excluded.start_at,
                end_at = excluded.end_at,
                start_utc = excluded.start_utc,
                end_utc = excluded.end_utc,
                all_day = excluded.all_day,
                time_zone = excluded.time_zone,
                location = excluded.location,
                attendees = excluded.attendees,
                status = excluded.status,
                change = excluded.change`;
          }
          const previousConversationId = prior[0]?.conversationId ?? null;
          touched.add(conversationId);
          if (previousConversationId !== null) touched.add(previousConversationId);
          return {
            seq,
            conversationId,
            previousConversationId,
            inserted: prior.length === 0,
            conversationWasRead: !(before.get(conversationId)?.unread ?? false),
            conversationWasDone: before.get(conversationId)?.done ?? false,
            conversationWasNew: !before.has(conversationId),
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

const RefreshedItem = ItemInsert.mapFields((fields) =>
  Struct.pick(fields, [
    "syncedAt",
    "title",
    "fromName",
    "fromAddress",
    "fromMe",
    "format",
    "bodyNew",
    "text",
    "textNew",
    "link",
    "raw",
  ]),
);
const RefreshedEvent = EventDetailRow.mapFields((fields) =>
  Struct.omit(fields, ["itemSeq", "change"]),
);

export const refreshItems = Effect.fnUntraced(function* (items: ReadonlyArray<ItemDraft>) {
  const sql = yield* SqlClient.SqlClient;
  const syncedAt = yield* DateTime.now;
  const seqs = yield* Effect.forEach(items, (item) =>
    Effect.gen(function* () {
      if (item.refresh === null || item.event === null) return [];
      const row = yield* Schema.encodeEffect(RefreshedItem)({ ...item, syncedAt });
      const detail = yield* Schema.encodeEffect(RefreshedEvent)(item.event);
      yield* sql`UPDATE item SET ${sql.update(row)} WHERE seq = ${item.refresh}`;
      yield* sql`UPDATE event_detail SET ${sql.update(detail)} WHERE item_seq = ${item.refresh}`;
      return [item.refresh];
    }),
  ).pipe(Effect.map((nested) => nested.flat()));
  if (seqs.length === 0) return [];
  yield* indexItems(sql.in("item.seq", seqs));
  const conversations = yield* decodeConversationIds(
    yield* sql`SELECT DISTINCT conversation_id AS id FROM item WHERE ${sql.in("seq", seqs)}`,
  );
  const ids = conversations.map(({ id }) => id);
  yield* recomputeConversations(ids);
  return ids;
});

export const softDeleteItems = Effect.fnUntraced(function* (
  streamId: StreamId,
  externalIds: ReadonlyArray<string>,
) {
  if (externalIds.length === 0) return { conversationIds: [], threads: [] };
  const sql = yield* SqlClient.SqlClient;
  const deletedAt = yield* Schema.encodeEffect(UtcIso)(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const deleted = yield* decodeDeleted(
        yield* sql`UPDATE item SET deleted_at = ${deletedAt}
          WHERE stream_id = ${streamId} AND deleted_at IS NULL AND ${sql.in("external_id", externalIds)}
          RETURNING seq, conversation_id, coalesce(thread_id, container_id) AS thread`,
      );
      if (deleted.length === 0) return { conversationIds: [], threads: [] };
      yield* sql`DELETE FROM search_fts WHERE ${sql.in(
        "rowid",
        deleted.map(({ seq }) => seq),
      )}`;
      const conversationIds = [...new Set(deleted.map(({ conversationId }) => conversationId))];
      yield* recomputeConversations(conversationIds);
      return { conversationIds, threads: [...new Set(deleted.map(({ thread }) => thread))] };
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

export const advanceClearedSeq = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
) {
  if (conversationIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO conversation_state (conversation_id, seen_seq, cleared_seq, muted)
    SELECT id, last_seq, last_seq, 0 FROM conversation WHERE ${sql.in("id", conversationIds)}
    ON CONFLICT (conversation_id) DO UPDATE SET
      cleared_seq = max(conversation_state.cleared_seq, excluded.cleared_seq)`;
});

export const replaceOccurrences = Effect.fnUntraced(function* (
  sourceId: string,
  series: ReadonlyArray<SeriesOccurrences>,
) {
  if (series.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM event_occurrence WHERE source_id = ${sourceId}
    AND ${sql.in(
      "series_id",
      series.map(({ seriesId }) => seriesId),
    )}`;
  const rows = yield* encodeOccurrences(
    series.flatMap(({ seriesId, occurrences }) =>
      occurrences.map((occurrence) => ({
        sourceId,
        seriesId,
        eventId: occurrence.eventId,
        startAt: occurrence.start,
        endAt: occurrence.end,
        startUtc: utcOf(occurrence.start, occurrence.allDay),
        endUtc: utcOf(occurrence.end, occurrence.allDay),
        allDay: occurrence.allDay,
        status: occurrence.status,
      })),
    ),
  );
  if (rows.length === 0) return;
  yield* sql`INSERT INTO event_occurrence ${sql.insert(rows)}
    ON CONFLICT (source_id, series_id, event_id) DO UPDATE SET
      start_at = excluded.start_at,
      end_at = excluded.end_at,
      start_utc = excluded.start_utc,
      end_utc = excluded.end_utc,
      all_day = excluded.all_day,
      status = excluded.status`;
});

export type StateChange =
  | { readonly _tag: "Read"; readonly seq: Seq }
  | { readonly _tag: "Unread"; readonly seq?: Seq }
  | { readonly _tag: "Done"; readonly seq: Seq }
  | { readonly _tag: "Mute" }
  | { readonly _tag: "Restore" }
  | { readonly _tag: "Plan"; readonly plan: Plan }
  | { readonly _tag: "Due"; readonly due: DueOverride };

const planAssignments = (sql: SqlClient.SqlClient, plan: Plan, plannedAt: string) => {
  const [kind, date, start, minutes] =
    plan._tag === "None"
      ? [null, null, null, null]
      : plan._tag === "Tray"
        ? ["tray", null, null, null]
        : plan._tag === "Day"
          ? ["day", plan.date, null, null]
          : ["slot", plan.date, plan.start, plan.minutes];
  return sql`plan_kind = ${kind}, plan_date = ${date}, plan_start = ${start},
    plan_minutes = ${minutes}, planned_at = ${kind === null ? null : plannedAt}`;
};

const stateAssignments = (sql: SqlClient.SqlClient, change: StateChange, plannedAt: string) => {
  const last = sql`conversation.last_seq`;
  const unplan = planAssignments(sql, { _tag: "None" }, plannedAt);
  switch (change._tag) {
    case "Read":
      return sql`seen_seq = max(seen_seq, min(${change.seq}, ${last}))`;
    case "Unread":
      return sql`seen_seq = max(0, min(${change.seq ?? last}, ${last}) - 1)`;
    case "Done":
      return sql`cleared_seq = max(cleared_seq, min(${change.seq}, ${last})), ${unplan}`;
    case "Mute":
      return sql`muted = 1`;
    case "Restore":
      return sql`muted = 0, cleared_seq = 0, seen_seq = max(seen_seq, ${last}), ${unplan}`;
    case "Plan":
      return planAssignments(sql, change.plan, plannedAt);
    case "Due":
      return change.due._tag === "Date"
        ? sql`due_kind = 'date', due_date = ${change.due.date}`
        : sql`due_kind = ${change.due._tag === "Cleared" ? "cleared" : null}, due_date = NULL`;
  }
};

const stateColumns = `conversation_id, seen_seq, cleared_seq, muted,
  plan_kind, plan_date, plan_start, plan_minutes, due_kind, due_date`;

export const changeState = Effect.fnUntraced(function* (
  conversationIds: ReadonlyArray<ConversationId>,
  change: StateChange,
) {
  if (conversationIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const plannedAt = yield* Schema.encodeEffect(UtcIso)(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO conversation_state (conversation_id, seen_seq, cleared_seq, muted)
        SELECT id, 0, 0, 0 FROM conversation WHERE ${sql.in("id", conversationIds)}
        ON CONFLICT (conversation_id) DO NOTHING`;
      const snapshot = ({ conversationId, ...state }: Record<string, unknown>) =>
        [Number(conversationId), JSON.stringify(state)] as const;
      const before = new Map(
        (yield* sql<Record<string, unknown>>`SELECT ${sql.literal(stateColumns)}
          FROM conversation_state
          WHERE ${sql.in("conversation_id", conversationIds)}`).map(snapshot),
      );
      const after = yield* sql<Record<string, unknown>>`UPDATE conversation_state
        SET ${stateAssignments(sql, change, plannedAt)}
        FROM conversation
        WHERE conversation.id = conversation_state.conversation_id
          AND ${sql.in("conversation_state.conversation_id", conversationIds)}
        RETURNING ${sql.literal(stateColumns)}`;
      return after
        .map(snapshot)
        .filter(([id, state]) => before.get(id) !== state)
        .map(([id]) => ConversationId.make(id))
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
  yield* sql`UPDATE stream SET last_sync_at = ${row.startedAt}, last_error = ${row.error},
    last_ok_at = ${row.error === null ? row.startedAt : sql`last_ok_at`}
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

export const reconcileAiState = Effect.fnUntraced(function* (scopes: ReadonlyArray<AiScope>) {
  const sql = yield* SqlClient.SqlClient;
  const enabled = sql.or(
    AiKind.literals.map((kind) =>
      sql.and([
        sql`kind = ${kind}`,
        sql.in(
          "name",
          scopes.filter((scope) => scope.kind === kind).map(({ name }) => name),
        ),
      ]),
    ),
  );
  yield* sql`DELETE FROM ai_state WHERE NOT ${enabled}`;
  if (scopes.length === 0) return;
  const aiSince = yield* DateTime.now;
  const rows = yield* encodeAiStates(scopes.map((scope) => ({ ...scope, aiSince })));
  yield* sql`INSERT INTO ai_state ${sql.insert(rows)} ON CONFLICT (kind, name) DO NOTHING`;
});

export const recordDigestRun = Effect.fnUntraced(function* (run: DigestRunInsert) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO digest_run ${sql.insert(yield* Schema.encodeEffect(DigestRunInsert)(run))}`;
});

const decodeDigest = Schema.decodeUnknownEffect(Schema.Tuple([DigestRow]));

export type DigestWrite =
  | { readonly _tag: "Written"; readonly digest: DigestRow }
  | { readonly _tag: "Stale" };

export const writeDigest = Effect.fnUntraced(function* (
  digest: DigestInsert,
  run: DigestRunInsert,
  replaces: DigestId | null,
  readSeqs: ReadonlySet<Seq>,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* Schema.encodeEffect(DigestInsert)(digest);
  const text = [digest.headline, ...digest.topics.flatMap(({ title, body }) => [title, body])].join(
    "\n",
  );
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* recordDigestRun(run);
      const inRange = yield* sql<{ readonly seq: Seq }>`SELECT seq FROM item
        WHERE conversation_id = ${digest.conversationId} AND deleted_at IS NULL
          AND kind IS NOT 'event'
          AND seq BETWEEN ${digest.fromSeq} AND ${digest.toSeq}`;
      if (inRange.some(({ seq }) => !readSeqs.has(seq)))
        return { _tag: "Stale" } satisfies DigestWrite;
      const [written] = yield* decodeDigest(
        yield* sql`INSERT INTO digest ${sql.insert(row)} RETURNING *`,
      );
      yield* sql`INSERT INTO search_fts (rowid, text, conversation_id, item_seq, digest_id)
        VALUES (${-written.id}, ${text}, ${written.conversationId}, NULL, ${written.id})`;
      if (replaces !== null) {
        yield* sql`DELETE FROM digest WHERE id = ${replaces}`;
        yield* sql`DELETE FROM search_fts WHERE rowid = ${-replaces}`;
      }
      return { _tag: "Written", digest: written } satisfies DigestWrite;
    }),
  );
});

const decodeStoredFaces = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      address: Schema.String,
      hash: Schema.NullOr(FaceHash),
      kind: Schema.NullOr(FaceKind),
    }),
  ),
);

export const putFaces = Effect.fnUntraced(function* (
  sourceId: string,
  outcomes: ReadonlyArray<FaceOutcome>,
  fetchedAt: DateTime.Utc,
) {
  if (outcomes.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const fetched = yield* Schema.encodeEffect(UtcIso)(fetchedAt);
  const blobs = new Map(
    outcomes.flatMap((outcome) =>
      outcome.status === "found"
        ? [
            [
              outcome.address,
              {
                hash: FaceHash.make(
                  new Bun.CryptoHasher("sha256").update(outcome.bytes).digest("hex"),
                ),
                mime: outcome.mime,
                bytes: outcome.bytes,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const faces = outcomes.map((outcome) => ({
    sourceId,
    address: outcome.address,
    hash: blobs.get(outcome.address)?.hash ?? null,
    kind: outcome.status === "found" ? outcome.kind : null,
    fetchedAt: fetched,
  }));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const previous = new Map(
        (yield* decodeStoredFaces(
          yield* sql`SELECT address, hash, kind FROM face WHERE source_id = ${sourceId}
            AND ${sql.in(
              "address",
              faces.map(({ address }) => address),
            )}`,
        )).map(({ address, hash, kind }) => [address, { hash, kind }]),
      );
      if (blobs.size > 0) {
        yield* sql`INSERT INTO face_blob ${sql.insert([...blobs.values()])}
          ON CONFLICT (hash) DO NOTHING`;
      }
      yield* sql`INSERT INTO face ${sql.insert(faces)}
        ON CONFLICT (source_id, address) DO UPDATE SET
          hash = excluded.hash,
          kind = excluded.kind,
          fetched_at = excluded.fetched_at`;
      const released = [...previous.values()].flatMap(({ hash }) => (hash === null ? [] : [hash]));
      if (released.length > 0) {
        yield* sql`DELETE FROM face_blob WHERE ${sql.in("hash", released)}
          AND NOT EXISTS (SELECT 1 FROM face WHERE face.hash = face_blob.hash)`;
      }
      return faces
        .filter(({ address, hash, kind }) => {
          const before = previous.get(address) ?? { hash: null, kind: null };
          return before.hash !== hash || before.kind !== kind;
        })
        .map(({ address }) => address);
    }),
  );
});
