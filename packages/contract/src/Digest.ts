import * as Schema from "effect/Schema";
import { Party } from "./Source.ts";

export const digestInputFence = "weir-digest-input";
export const digestErrorFence = "weir-digest-error";

export const TopicState = Schema.Literals(["open", "resolved", "fyi"]);
export type TopicState = typeof TopicState.Type;

export const Trigger = Schema.Literals(["auto", "manual"]);
export type Trigger = typeof Trigger.Type;

export const Topic = Schema.Struct({
  title: Schema.String,
  state: TopicState,
  body: Schema.String,
  seqs: Schema.Array(Schema.Int),
});
export type Topic = typeof Topic.Type;

export const digestLimits = {
  headline: { han: 40, total: 70 },
  title: { han: 16, total: 40 },
  body: { han: 80, total: 160 },
  topics: { min: 1, max: 4 },
} as const;

const Text = ({ han, total }: { readonly han: number; readonly total: number }) =>
  Schema.Trim.check(
    Schema.isNonEmpty(),
    Schema.makeFilter(
      (text: string) =>
        ((text.match(/\p{Script=Han}/gu)?.length ?? 0) <= han && [...text].length <= total) ||
        `at most ${han} CJK characters and ${total} characters in total`,
    ),
  );

const Seqs = Schema.NonEmptyArray(Schema.Int).check(
  Schema.makeFilter(
    (seqs: ReadonlyArray<number>) =>
      seqs.every((seq, index) => index === 0 || (seqs[index - 1] ?? seq) < seq) ||
      "seqs must be unique and ascending",
  ),
);

export const DigestOutput = Schema.Struct({
  headline: Text(digestLimits.headline),
  topics: Schema.Array(
    Schema.Struct({
      title: Text(digestLimits.title),
      state: TopicState,
      body: Text(digestLimits.body),
      seqs: Seqs,
    }),
  ).check(
    Schema.isMinLength(digestLimits.topics.min),
    Schema.isMaxLength(digestLimits.topics.max),
    Schema.makeFilter((topics: ReadonlyArray<{ readonly seqs: ReadonlyArray<number> }>) => {
      const seqs = topics.flatMap((topic) => topic.seqs);
      return new Set(seqs).size === seqs.length || "an item belongs to at most one topic";
    }),
  ),
});
export type DigestOutput = typeof DigestOutput.Type;

export const Digest = Schema.Struct({
  id: Schema.Int,
  conversation_id: Schema.Int,
  from_seq: Schema.Int,
  to_seq: Schema.Int,
  headline: Schema.String,
  topics: Schema.Array(Topic),
  trigger: Trigger,
  ai_profile: Schema.String,
  created_at: Schema.String,
});
export type Digest = typeof Digest.Type;

const itemFields = {
  seq: Schema.Int,
  occurred_at: Schema.String,
  from: Party,
  from_me: Schema.Boolean,
  title: Schema.NullOr(Schema.String),
};

export const InputItem = Schema.Struct({ ...itemFields, body_new: Schema.String });
export type InputItem = typeof InputItem.Type;

export const ContextEntry = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("digest"),
    from_seq: Schema.Int,
    to_seq: Schema.Int,
    headline: Schema.String,
    topics: Schema.Array(Topic),
  }),
  Schema.Struct({ kind: Schema.Literal("item"), ...itemFields, body: Schema.String }),
]);
export type ContextEntry = typeof ContextEntry.Type;

export const DigestInput = Schema.Struct({
  language: Schema.String,
  guide: Schema.NullOr(Schema.String),
  conversation: Schema.Struct({ id: Schema.Int, source: Schema.String, title: Schema.String }),
  range: Schema.Struct({ from_seq: Schema.Int, to_seq: Schema.Int }),
  context: Schema.Array(ContextEntry),
  items: Schema.Array(InputItem),
});
export type DigestInput = typeof DigestInput.Type;
