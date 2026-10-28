import * as Schema from "effect/Schema";

type Json = string | number | boolean | null;
export type Rule =
  | { readonly type: "and"; readonly rules: ReadonlyArray<Rule> }
  | { readonly type: "or"; readonly rules: ReadonlyArray<Rule> }
  | { readonly type: "not"; readonly rule: Rule }
  | { readonly type: "eq"; readonly target: string; readonly is: Json }
  | { readonly type: "regex"; readonly target: string; readonly regex: string; readonly flags?: string }
  | { readonly type: "exists"; readonly target: string }
  | { readonly type: "some"; readonly target: string; readonly rule: Rule }
  | { readonly type: "every"; readonly target: string; readonly rule: Rule };

const Pointer = Schema.String.pipe(Schema.check(Schema.isPattern(/^(\/([^~/]|~[01])*)*$/)));
const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
const RuleRef = Schema.suspend((): Schema.Codec<Rule> => Rule);
export const Rule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("and"), rules: Schema.Array(RuleRef) }),
  Schema.Struct({ type: Schema.Literal("or"), rules: Schema.Array(RuleRef) }),
  Schema.Struct({ type: Schema.Literal("not"), rule: RuleRef }),
  Schema.Struct({ type: Schema.Literal("eq"), target: Pointer, is: Scalar }),
  Schema.Struct({ type: Schema.Literal("regex"), target: Pointer, regex: Schema.String, flags: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("exists"), target: Pointer }),
  Schema.Struct({ type: Schema.Literal("some"), target: Pointer, rule: RuleRef }),
  Schema.Struct({ type: Schema.Literal("every"), target: Pointer, rule: RuleRef }),
]).pipe(Schema.toTaggedUnion("type"));

const Tag = Schema.Struct({ name: Schema.String, ai: Schema.optional(Schema.Boolean), match: Rule });
export const Config = Schema.Struct({
  digest: Schema.Struct({ threshold: Schema.Number, max_input: Schema.Number, context: Schema.Number }),
  tag: Schema.optional(Schema.Array(Tag)),
  tag_state: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type Config = typeof Config.Type;

export const decodeConfig = (toml: string): Config => Schema.decodeUnknownSync(Config)(Bun.TOML.parse(toml), { onExcessProperty: "error" });

export const resolve = (root: unknown, pointer: string): unknown => {
  if (pointer === "") return root;
  let cur: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
};

export const match = (rule: Rule, root: unknown): boolean =>
  Rule.match(rule, {
    and: (r) => r.rules.every((x) => match(x, root)),
    or: (r) => r.rules.some((x) => match(x, root)),
    not: (r) => !match(r.rule, root),
    eq: (r) => resolve(root, r.target) === r.is,
    regex: (r) => {
      const v = resolve(root, r.target);
      return typeof v === "string" && new RegExp(r.regex, r.flags).test(v);
    },
    exists: (r) => resolve(root, r.target) !== undefined,
    some: (r) => {
      const v = resolve(root, r.target);
      return Array.isArray(v) && v.some((e) => match(r.rule, e));
    },
    every: (r) => {
      const v = resolve(root, r.target);
      return Array.isArray(v) && v.every((e) => match(r.rule, e));
    },
  });
