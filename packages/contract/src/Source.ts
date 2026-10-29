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

export const RowParty = Schema.Struct({ ...Party.fields, me: Schema.Boolean });
export type RowParty = typeof RowParty.Type;

export const RawItem = Schema.Struct({
  externalId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  containerId: Schema.String,
  containerName: Schema.String,
  occurredAt: IsoDateTimeWithOffset,
  title: Schema.NullOr(Schema.String),
  from: Party,
  body: Schema.String,
  bodyNew: Schema.NullOr(Schema.String),
  link: Schema.NullOr(Schema.String),
  raw: Schema.Unknown,
});
export type RawItem = typeof RawItem.Type;

export const StreamDescriptor = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("message"),
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
  kind: Schema.Literals(["live", "backfill"]),
  backfill: Schema.Literals(["running", "done"]),
});
export type SyncPage = typeof SyncPage.Type;

export interface Source {
  streams(): Promise<ReadonlyArray<StreamDescriptor>>;
  sync(streamId: string, cursor: string | null): Promise<SyncPage>;
}

export interface SourcePlugin<Config> {
  readonly id: string;
  readonly configSchema: StandardSchemaV1<unknown, Config>;
  create(config: Config): Source;
}
