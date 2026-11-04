import { CalendarDate, Topic, Trigger } from "@weir/contract/Digest";
import {
  BodyFormat,
  EventAttendee,
  EventStatus,
  RowParty,
  StreamDescriptor,
} from "@weir/contract/Source";
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
  lastOkAt: Schema.NullOr(UtcIso),
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
  format: BodyFormat,
  bodyNew: Schema.String,
  text: Schema.String,
  textNew: Schema.String,
  link: Schema.NullOr(Schema.String),
  raw: Schema.fromJsonString(Schema.Unknown),
  deletedAt: Schema.NullOr(UtcIso),
};

export const ItemInsert = Schema.Struct(itemFields);

export const ItemRow = Schema.Struct({ seq: Seq, ...itemFields });
export type ItemRow = typeof ItemRow.Type;

export const SourcedItemRow = Schema.Struct({
  ...ItemRow.fields,
  sourceId: Schema.String,
  conversationKey: Schema.String,
});
export type SourcedItemRow = typeof SourcedItemRow.Type;

export const EventChange = Schema.Union([
  Schema.TaggedStruct("Created", {}),
  Schema.TaggedStruct("Moved", { fromStart: Schema.String, fromEnd: Schema.String }),
  Schema.TaggedStruct("Relocated", { fromLocation: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("Cancelled", {}),
]);
export type EventChange = typeof EventChange.Type;

const eventTimeFields = {
  eventId: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
  startUtc: UtcIso,
  endUtc: UtcIso,
  allDay: Schema.BooleanFromBit,
  status: EventStatus,
};

export const EventDetailRow = Schema.Struct({
  itemSeq: Seq,
  ...eventTimeFields,
  seriesId: Schema.NullOr(Schema.String),
  recurring: Schema.BooleanFromBit,
  timeZone: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  attendees: Schema.fromJsonString(Schema.Array(EventAttendee)),
  change: Schema.fromJsonString(Schema.NullOr(EventChange)),
});
export type EventDetailRow = typeof EventDetailRow.Type;

export const EventOccurrenceRow = Schema.Struct({
  sourceId: Schema.String,
  seriesId: Schema.String,
  ...eventTimeFields,
});
export type EventOccurrenceRow = typeof EventOccurrenceRow.Type;

export const MeetingRow = Schema.Struct({
  conversationId: ConversationId,
  itemSeq: Seq,
  eventId: Schema.String,
  seriesId: Schema.NullOr(Schema.String),
  title: Schema.String,
  startAt: Schema.String,
  endAt: Schema.String,
  startUtc: UtcIso,
  endUtc: UtcIso,
  allDay: Schema.BooleanFromBit,
  location: Schema.NullOr(Schema.String),
  status: EventStatus,
  change: Schema.fromJsonString(Schema.NullOr(EventChange)),
  recurring: Schema.BooleanFromBit,
});
export type MeetingRow = typeof MeetingRow.Type;

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

export const ConversationState = Schema.Literals(["unread", "read", "done", "muted", "planned"]);
export type ConversationState = typeof ConversationState.Type;

export const Plan = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Tray", {}),
  Schema.TaggedStruct("Day", { date: CalendarDate }),
  Schema.TaggedStruct("Slot", {
    date: CalendarDate,
    start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1439 })),
    minutes: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);
export type Plan = typeof Plan.Type;

export const DueOverride = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Date", { date: CalendarDate }),
  Schema.TaggedStruct("Cleared", {}),
]);
export type DueOverride = typeof DueOverride.Type;

export const RowDue = Schema.Struct({
  date: CalendarDate,
  by: Schema.Union([
    Schema.TaggedStruct("Ai", { seq: Schema.Int }),
    Schema.TaggedStruct("User", {}),
  ]),
});
export type RowDue = typeof RowDue.Type;

export const ListedConversationRow = Schema.Struct({
  ...ConversationRow.fields,
  seenSeq: Seq,
  clearedSeq: Seq,
  muted: Schema.BooleanFromBit,
  state: ConversationState,
  tags: Schema.fromJsonString(Schema.Array(Schema.String)),
  newItems: Schema.Int,
  items: Schema.Int,
  participants: Schema.Int,
  from: Schema.fromJsonString(RowParty),
  senders: Schema.fromJsonString(Schema.Array(RowParty)),
  lastFromName: Schema.String,
  lastFromAddress: Schema.String,
  lastFromMe: Schema.BooleanFromBit,
  lastTextNew: Schema.String,
  coveringHeadline: Schema.NullOr(Schema.String),
  plan: Schema.fromJsonString(Plan),
  plannedAt: Schema.NullOr(UtcIso),
  due: Schema.NullOr(Schema.fromJsonString(RowDue)),
});
export type ListedConversationRow = typeof ListedConversationRow.Type;

export const AiKind = Schema.Literals(["tag", "group"]);
export type AiKind = typeof AiKind.Type;

export const AiScope = Schema.Struct({ kind: AiKind, name: Schema.String });
export type AiScope = typeof AiScope.Type;

export const AiStateRow = Schema.Struct({ ...AiScope.fields, aiSince: UtcIso });
export type AiStateRow = typeof AiStateRow.Type;

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

const digestFields = {
  conversationId: ConversationId,
  fromSeq: Seq,
  toSeq: Seq,
  headline: Schema.String,
  topics: Schema.fromJsonString(Schema.Array(Topic)),
  trigger: Trigger,
  aiProfile: Schema.String,
  createdAt: UtcIso,
};

export const DigestInsert = Schema.Struct(digestFields);
export type DigestInsert = typeof DigestInsert.Type;

export const DigestRow = Schema.Struct({ id: DigestId, ...digestFields });
export type DigestRow = typeof DigestRow.Type;

const digestRunFields = {
  conversationId: ConversationId,
  fromSeq: Seq,
  toSeq: Seq,
  trigger: Trigger,
  ai: Schema.String,
  startedAt: UtcIso,
  ms: Schema.Int,
  ok: Schema.BooleanFromBit,
  error: Schema.NullOr(Schema.String),
  logPath: Schema.NullOr(Schema.String),
};

export const DigestRunInsert = Schema.Struct(digestRunFields);
export type DigestRunInsert = typeof DigestRunInsert.Type;

export const DigestRunRow = Schema.Struct({ id: Schema.Int, ...digestRunFields });
export type DigestRunRow = typeof DigestRunRow.Type;

export const ItemLiteRow = Schema.Struct({ seq: Seq, occurredAt: UtcIso, chars: Schema.Int });
export type ItemLiteRow = typeof ItemLiteRow.Type;

export const SearchFtsRow = Schema.Struct({
  text: Schema.String,
  conversationId: ConversationId,
  itemSeq: Schema.NullOr(Seq),
  digestId: Schema.NullOr(DigestId),
});
export type SearchFtsRow = typeof SearchFtsRow.Type;
