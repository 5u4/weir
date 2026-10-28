import { StreamDescriptor } from "@weir/contract/Source";
import * as Schema from "effect/Schema";

export const UtcIso = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));

export const StreamId = Schema.Int.pipe(Schema.brand("StreamId"));
export type StreamId = typeof StreamId.Type;

export const Seq = Schema.Int.pipe(Schema.brand("Seq"));
export type Seq = typeof Seq.Type;

export const ConversationId = Schema.Int.pipe(Schema.brand("ConversationId"));
export type ConversationId = typeof ConversationId.Type;

export const DigestId = Schema.Int.pipe(Schema.brand("DigestId"));
export type DigestId = typeof DigestId.Type;

const Kind = StreamDescriptor.fields.kind;
const Trigger = Schema.Literals(["auto", "manual"]);

const streamFields = {
  sourceId: Schema.String,
  externalId: Schema.String,
  kind: Kind,
  name: Schema.String,
  openLabel: Schema.String,
  me: Schema.fromJsonString(Schema.Array(Schema.String)),
  cursor: Schema.NullOr(Schema.String),
  backfilledAt: Schema.NullOr(UtcIso),
  lastSyncAt: Schema.NullOr(UtcIso),
  lastError: Schema.NullOr(Schema.String),
};

export const StreamInsert = Schema.Struct(streamFields);

export const StreamRow = Schema.Struct({ id: StreamId, ...streamFields });
export type StreamRow = typeof StreamRow.Type;

const itemFields = {
  streamId: StreamId,
  externalId: Schema.String,
  kind: Kind,
  conversationId: ConversationId,
  threadId: Schema.NullOr(Schema.String),
  containerId: Schema.String,
  containerName: Schema.String,
  occurredAt: UtcIso,
  syncedAt: UtcIso,
  title: Schema.NullOr(Schema.String),
  fromName: Schema.String,
  fromAddress: Schema.String,
  fromMe: Schema.BooleanFromBit,
  body: Schema.String,
  bodyNew: Schema.String,
  link: Schema.NullOr(Schema.String),
  raw: Schema.fromJsonString(Schema.Unknown),
  deletedAt: Schema.NullOr(UtcIso),
};

export const ItemInsert = Schema.Struct(itemFields);

export const ItemRow = Schema.Struct({ seq: Seq, ...itemFields });
export type ItemRow = typeof ItemRow.Type;

export const SourcedItemRow = Schema.Struct({ ...ItemRow.fields, sourceId: Schema.String });
export type SourcedItemRow = typeof SourcedItemRow.Type;

export const ConversationRow = Schema.Struct({
  id: ConversationId,
  sourceId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  firstAt: UtcIso,
  lastAt: UtcIso,
  lastSeq: Seq,
});
export type ConversationRow = typeof ConversationRow.Type;

export const ConversationTagRow = Schema.Struct({
  conversationId: ConversationId,
  tag: Schema.String,
});
export type ConversationTagRow = typeof ConversationTagRow.Type;

export const ConversationStateRow = Schema.Struct({
  conversationId: ConversationId,
  seenSeq: Seq,
  clearedSeq: Seq,
  muted: Schema.BooleanFromBit,
});
export type ConversationStateRow = typeof ConversationStateRow.Type;

export const TagStateRow = Schema.Struct({
  name: Schema.String,
  aiSince: UtcIso,
});
export type TagStateRow = typeof TagStateRow.Type;

const syncRunFields = {
  streamId: StreamId,
  startedAt: UtcIso,
  ms: Schema.Int,
  upserts: Schema.Int,
  deletions: Schema.Int,
  error: Schema.NullOr(Schema.String),
};

export const SyncRunInsert = Schema.Struct(syncRunFields);
export type SyncRunInsert = typeof SyncRunInsert.Type;

export const SyncRunRow = Schema.Struct({ id: Schema.Int, ...syncRunFields });
export type SyncRunRow = typeof SyncRunRow.Type;

export const Topic = Schema.Struct({
  title: Schema.String,
  state: Schema.Literals(["open", "resolved", "fyi"]),
  body: Schema.String,
  seqs: Schema.Array(Seq),
});
export type Topic = typeof Topic.Type;

export const DigestRow = Schema.Struct({
  id: DigestId,
  conversationId: ConversationId,
  fromSeq: Seq,
  toSeq: Seq,
  headline: Schema.String,
  topics: Schema.fromJsonString(Schema.Array(Topic)),
  trigger: Trigger,
  aiProfile: Schema.String,
  createdAt: UtcIso,
});
export type DigestRow = typeof DigestRow.Type;

export const DigestRunRow = Schema.Struct({
  id: Schema.Int,
  conversationId: ConversationId,
  fromSeq: Seq,
  toSeq: Seq,
  trigger: Trigger,
  ai: Schema.String,
  ms: Schema.Int,
  ok: Schema.BooleanFromBit,
  error: Schema.NullOr(Schema.String),
  logPath: Schema.NullOr(Schema.String),
});
export type DigestRunRow = typeof DigestRunRow.Type;

export const SearchFtsRow = Schema.Struct({
  text: Schema.String,
  conversationId: ConversationId,
  itemSeq: Schema.NullOr(Seq),
  digestId: Schema.NullOr(DigestId),
});
export type SearchFtsRow = typeof SearchFtsRow.Type;
