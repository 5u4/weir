import * as Schema from "effect/Schema";

export type Scalar = string | number | boolean | null;

interface And<R> {
  readonly type: "and";
  readonly rules: ReadonlyArray<R>;
}
interface Or<R> {
  readonly type: "or";
  readonly rules: ReadonlyArray<R>;
}
interface Not<R> {
  readonly type: "not";
  readonly rule: R;
}
interface Some<R> {
  readonly type: "some";
  readonly target: string;
  readonly rule: R;
}
interface Every<R> {
  readonly type: "every";
  readonly target: string;
  readonly rule: R;
}
type Leaf =
  | { readonly type: "eq"; readonly target: string; readonly is: Scalar }
  | {
      readonly type: "regex";
      readonly target: string;
      readonly regex: string;
      readonly flags?: string;
    }
  | { readonly type: "exists"; readonly target: string };
export type ItemRule =
  | And<ItemRule>
  | Or<ItemRule>
  | Not<ItemRule>
  | Some<ItemRule>
  | Every<ItemRule>
  | Leaf;
export type TagRule =
  | And<TagRule>
  | Or<TagRule>
  | Not<TagRule>
  | Some<TagRule>
  | Every<TagRule>
  | Leaf
  | { readonly type: "group"; readonly name: string };

const Pointer = Schema.String.check(Schema.isPattern(/^(\/([^~/]|~[01])*)*$/));
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);

const variants = <R>(self: Schema.Codec<R>) =>
  [
    Schema.Struct({ type: Schema.Literal("and"), rules: Schema.Array(self) }),
    Schema.Struct({ type: Schema.Literal("or"), rules: Schema.Array(self) }),
    Schema.Struct({ type: Schema.Literal("not"), rule: self }),
    Schema.Struct({ type: Schema.Literal("eq"), target: Pointer, is: Scalar }),
    Schema.Struct({
      type: Schema.Literal("regex"),
      target: Pointer,
      regex: Schema.String,
      flags: Schema.optionalKey(Schema.String),
    }).check(
      Schema.makeFilter(({ regex, flags }) => {
        try {
          new RegExp(regex, flags);
          return undefined;
        } catch (error) {
          return {
            path: ["regex"],
            issue: error instanceof Error ? error.message : "invalid regex",
          };
        }
      }),
    ),
    Schema.Struct({ type: Schema.Literal("exists"), target: Pointer }),
    Schema.Struct({ type: Schema.Literal("some"), target: Pointer, rule: self }),
    Schema.Struct({ type: Schema.Literal("every"), target: Pointer, rule: self }),
  ] as const;

export const ItemRule = Schema.Union(
  variants(Schema.suspend((): Schema.Codec<ItemRule> => ItemRule)),
).pipe(Schema.toTaggedUnion("type"));

export const TagRule = Schema.Union([
  ...variants(Schema.suspend((): Schema.Codec<TagRule> => TagRule)),
  Schema.Struct({
    type: Schema.Literal("group"),
    name: Schema.String.check(Schema.isMinLength(1)),
  }),
]).pipe(Schema.toTaggedUnion("type"));

export const groupNames = (rule: TagRule): ReadonlyArray<string> =>
  TagRule.match(rule, {
    and: ({ rules }) => rules.flatMap(groupNames),
    or: ({ rules }) => rules.flatMap(groupNames),
    not: ({ rule: inner }) => groupNames(inner),
    eq: () => [],
    regex: () => [],
    exists: () => [],
    some: ({ rule: inner }) => groupNames(inner),
    every: ({ rule: inner }) => groupNames(inner),
    group: ({ name }) => [name],
  });

export const RuleInput = Schema.Struct({
  source: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  containerId: Schema.String,
  containerName: Schema.String,
  title: Schema.NullOr(Schema.String),
  from: Schema.Struct({ name: Schema.String, address: Schema.String }),
  fromMe: Schema.Boolean,
  body: Schema.String,
  raw: Schema.Unknown,
});
export type RuleInput = typeof RuleInput.Type;
