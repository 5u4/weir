import * as Schema from "effect/Schema";
import type { StandardSchemaV1 } from "effect/StandardSchema";

const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const isRealDateTime = (input: string): boolean => {
  const year = Number(input.slice(0, 4));
  const month = Number(input.slice(5, 7));
  const day = Number(input.slice(8, 10));
  const calendarDay = new Date(0);
  calendarDay.setUTCFullYear(year, month - 1, day);
  return (
    calendarDay.getUTCMonth() === month - 1 &&
    calendarDay.getUTCDate() === day &&
    !Number.isNaN(Date.parse(input))
  );
};

const IsoDateTimeWithOffset = Schema.String.check(
  Schema.isPattern(isoWithOffset),
  Schema.makeFilter((input: string) => isRealDateTime(input) || "invalid date"),
);

export const Party = Schema.Struct({
  name: Schema.String,
  address: Schema.String,
});
export type Party = typeof Party.Type;

export const RowParty = Schema.Struct({
  ...Party.fields,
  me: Schema.Boolean,
  verified: Schema.Boolean,
});
export type RowParty = typeof RowParty.Type;

export const BodyFormat = Schema.Literals(["markdown", "html"]);
export type BodyFormat = typeof BodyFormat.Type;

const MarkdownBody = Schema.Struct({
  format: Schema.Literal("markdown"),
  body: Schema.String,
  bodyNew: Schema.NullOr(Schema.String),
});
const HtmlBody = Schema.Struct({
  format: Schema.Literal("html"),
  body: Schema.String,
  bodyNew: Schema.String,
});

export const ItemBody = Schema.Union([MarkdownBody, HtmlBody]);
export type ItemBody = typeof ItemBody.Type;

export const EventStatus = Schema.Literals(["confirmed", "cancelled"]);
export type EventStatus = typeof EventStatus.Type;

export const EventAttendee = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
  response: Schema.NullOr(Schema.String),
});
export type EventAttendee = typeof EventAttendee.Type;

export const EventTime = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.Boolean,
});
export type EventTime = typeof EventTime.Type;

export const RawEvent = Schema.Struct({
  eventId: Schema.String,
  seriesId: Schema.NullOr(Schema.String),
  recurring: Schema.Boolean,
  time: Schema.NullOr(EventTime),
  timeZone: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  attendees: Schema.Array(EventAttendee),
  status: EventStatus,
  originalStart: Schema.NullOr(Schema.String),
});
export type RawEvent = typeof RawEvent.Type;

export const Occurrence = Schema.Struct({
  eventId: Schema.String,
  ...EventTime.fields,
  status: EventStatus,
});
export type Occurrence = typeof Occurrence.Type;

export const SeriesOccurrences = Schema.Struct({
  seriesId: Schema.String,
  occurrences: Schema.Array(Occurrence),
});
export type SeriesOccurrences = typeof SeriesOccurrences.Type;

const itemFields = {
  externalId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  containerId: Schema.String,
  containerName: Schema.String,
  occurredAt: IsoDateTimeWithOffset,
  title: Schema.NullOr(Schema.String),
  from: Party,
  fromVerified: Schema.Boolean,
  link: Schema.NullOr(Schema.String),
  raw: Schema.Unknown,
  event: Schema.optionalKey(RawEvent),
};

export const RawItem = Schema.Union([
  Schema.Struct({ ...itemFields, ...MarkdownBody.fields }),
  Schema.Struct({ ...itemFields, ...HtmlBody.fields }),
]);
export type RawItem = typeof RawItem.Type;

export const StreamDescriptor = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["message", "event"]),
  name: Schema.String,
  me: Schema.Array(Schema.String),
  openLabel: Schema.String,
});
export type StreamDescriptor = typeof StreamDescriptor.Type;

export const SyncPage = Schema.Struct({
  upserts: Schema.Array(RawItem),
  deletions: Schema.Array(Schema.String),
  cursor: Schema.String,
  more: Schema.Boolean,
  occurrences: Schema.optionalKey(Schema.Array(SeriesOccurrences)),
  kind: Schema.Literals(["live", "backfill"]),
  backfill: Schema.Literals(["running", "done"]),
});
export type SyncPage = typeof SyncPage.Type;

export const maxFaceBytes = 256 * 1024;

export const FaceMime = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
export type FaceMime = typeof FaceMime.Type;

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

const hasAt = (bytes: Uint8Array, at: number, expected: ReadonlyArray<number>) =>
  expected.every((byte, index) => bytes[at + index] === byte);

const utf8Bom = [0xef, 0xbb, 0xbf];
const svgWhitespace = new Set(ascii(" \t\r\n"));
const svgWindow = 1024;

const looksLikeSvg = (bytes: Uint8Array) => {
  let at = hasAt(bytes, 0, utf8Bom) ? utf8Bom.length : 0;
  while (at < bytes.length && svgWhitespace.has(bytes[at] ?? 0)) at++;
  return (
    bytes[at] === 0x3c && new TextDecoder().decode(bytes.subarray(0, svgWindow)).includes("<svg")
  );
};

const looksLike: Record<FaceMime, (bytes: Uint8Array) => boolean> = {
  "image/png": (bytes) => hasAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (bytes) => hasAt(bytes, 0, [0xff, 0xd8, 0xff]),
  "image/gif": (bytes) => hasAt(bytes, 0, ascii("GIF87a")) || hasAt(bytes, 0, ascii("GIF89a")),
  "image/webp": (bytes) => hasAt(bytes, 0, ascii("RIFF")) && hasAt(bytes, 8, ascii("WEBP")),
  "image/svg+xml": looksLikeSvg,
};

export const FaceKind = Schema.Literals(["portrait", "logo"]);
export type FaceKind = typeof FaceKind.Type;

const FoundFace = Schema.Struct({
  status: Schema.Literal("found"),
  kind: FaceKind,
  mime: FaceMime,
  bytes: Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(maxFaceBytes)),
}).check(
  Schema.makeFilter(
    ({ mime, bytes }: { readonly mime: FaceMime; readonly bytes: Uint8Array }) =>
      looksLike[mime](bytes) || `bytes are not ${mime}`,
  ),
);

export const Face = Schema.Union([
  FoundFace,
  Schema.Struct({ status: Schema.Literal("missing") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]);
export type Face = typeof Face.Type;

export const Faces = Schema.Record(Schema.String, Face);
export type Faces = typeof Faces.Type;

export interface Source {
  streams(): Promise<ReadonlyArray<StreamDescriptor>>;
  sync(streamId: string, cursor: string | null, signal: AbortSignal): Promise<SyncPage>;
  faces?(addresses: ReadonlyArray<string>, signal: AbortSignal): Promise<Faces>;
}

export interface SourceHost {
  readonly now: () => number;
}

export interface SourcePlugin<Config> {
  readonly id: string;
  readonly configSchema: StandardSchemaV1<unknown, Config>;
  create(config: Config, host: SourceHost): Source;
}
