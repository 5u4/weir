import * as Schema from "effect/Schema";

export type Scalar = string | number | boolean | null;

export type Rule =
  | { readonly type: "and"; readonly rules: ReadonlyArray<Rule> }
  | { readonly type: "or"; readonly rules: ReadonlyArray<Rule> }
  | { readonly type: "not"; readonly rule: Rule }
  | { readonly type: "eq"; readonly target: string; readonly is: Scalar }
  | {
      readonly type: "regex";
      readonly target: string;
      readonly regex: string;
      readonly flags?: string;
    }
  | { readonly type: "exists"; readonly target: string }
  | { readonly type: "some"; readonly target: string; readonly rule: Rule }
  | { readonly type: "every"; readonly target: string; readonly rule: Rule };

const Pointer = Schema.String.check(Schema.isPattern(/^(\/([^~/]|~[01])*)*$/));
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
const RuleRef = Schema.suspend((): Schema.Codec<Rule> => Rule);

export const Rule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("and"), rules: Schema.Array(RuleRef) }),
  Schema.Struct({ type: Schema.Literal("or"), rules: Schema.Array(RuleRef) }),
  Schema.Struct({ type: Schema.Literal("not"), rule: RuleRef }),
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
        return { path: ["regex"], issue: error instanceof Error ? error.message : "invalid regex" };
      }
    }),
  ),
  Schema.Struct({ type: Schema.Literal("exists"), target: Pointer }),
  Schema.Struct({ type: Schema.Literal("some"), target: Pointer, rule: RuleRef }),
  Schema.Struct({ type: Schema.Literal("every"), target: Pointer, rule: RuleRef }),
]).pipe(Schema.toTaggedUnion("type"));
