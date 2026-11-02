import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Rule } from "./Rule.ts";

const unitMillis = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const DurationShorthand = Schema.String.check(
  Schema.isPattern(/^[1-9]\d*(ms|s|m|h|d)$/),
).pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transform({
      decode: (text) =>
        Duration.millis(
          Number.parseInt(text, 10) *
            unitMillis[text.replace(/^\d+/, "") as keyof typeof unitMillis],
        ),
      encode: (duration) => `${Duration.toMillis(duration)}ms`,
    }),
  ),
);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const AiProfile = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.String),
  timeout: DurationShorthand,
  concurrency: PositiveInt,
});
export type AiProfile = typeof AiProfile.Type;

export const DigestConfig = Schema.Struct({
  ai: Schema.String,
  threshold: PositiveInt,
  max_input: PositiveInt,
  context: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  language: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("zh-CN"))),
  guide: Schema.optionalKey(Schema.String),
});
export type DigestConfig = typeof DigestConfig.Type;

export const SourceConfig = Schema.Struct({
  id: NonEmptyString,
  plugin: NonEmptyString,
  sync_every: DurationShorthand,
  config: Schema.Unknown,
});
export type SourceConfig = typeof SourceConfig.Type;

export const untagged = "Untagged";

export const TagConfig = Schema.Struct({
  name: NonEmptyString.check(
    Schema.makeFilter(
      (name) => name.toLowerCase() !== untagged.toLowerCase() || `tag name "${name}" is reserved`,
    ),
  ),
  ai: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  match: Rule,
});
export type TagConfig = typeof TagConfig.Type;

export const GroupConfig = Schema.Struct({
  name: NonEmptyString,
  match: Rule,
});
export type GroupConfig = typeof GroupConfig.Type;

export const groupKeyPrefix = "group:";

const duplicatesOf = (
  section: string,
  field: string,
  values: ReadonlyArray<string>,
): Array<Schema.FilterIssue> =>
  values.flatMap((value, index) =>
    values.indexOf(value) < index
      ? [{ path: [section, index, field], issue: `duplicate ${field} "${value}"` }]
      : [],
  );

export const Config = Schema.Struct({
  port: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  ai: Schema.optionalKey(Schema.Record(Schema.String, AiProfile)),
  digest: Schema.optionalKey(DigestConfig),
  source: Schema.Array(SourceConfig).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  tag: Schema.Array(TagConfig).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  group: Schema.Array(GroupConfig).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}).check(
  Schema.makeFilter((config) => [
    ...duplicatesOf(
      "source",
      "id",
      config.source.map(({ id }) => id),
    ),
    ...duplicatesOf(
      "tag",
      "name",
      config.tag.map(({ name }) => name),
    ),
    ...duplicatesOf(
      "group",
      "name",
      config.group.map(({ name }) => name),
    ),
    ...(config.digest !== undefined && !Object.hasOwn(config.ai ?? {}, config.digest.ai)
      ? [{ path: ["digest", "ai"], issue: `unknown ai profile "${config.digest.ai}"` }]
      : []),
  ]),
);
export type Config = typeof Config.Type;

export const decodeConfig = Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" });
