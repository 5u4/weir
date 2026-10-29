import { DurationShorthand } from "@weir/contract/Config";
import { Digest, Trigger } from "@weir/contract/Digest";
import { Party, RowParty } from "@weir/contract/Source";
import { ConversationState } from "@weir/store/Rows";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const defaultPort = 9347;

export const ConfigIssue = Schema.Struct({ path: Schema.String, message: Schema.String });
export type ConfigIssue = typeof ConfigIssue.Type;

const configProblem = {
  file: Schema.String,
  message: Schema.String,
  issues: Schema.Array(ConfigIssue),
};
export const ConfigProblem = Schema.Struct(configProblem);

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()(
  "ConfigInvalid",
  configProblem,
  { httpApiStatus: 422 },
) {
  static fromIssues(file: string, issues: ReadonlyArray<ConfigIssue>) {
    return new ConfigInvalid({
      file,
      message: [
        `invalid config ${file}`,
        ...issues.map(({ path, message }) => `  ${path === "" ? "" : `${path}: `}${message}`),
      ].join("\n"),
      issues,
    });
  }
}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const StreamStatus = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  last_sync_at: Schema.NullOr(Schema.String),
  last_error: Schema.NullOr(Schema.String),
  backfill: Schema.Literals(["running", "done"]),
});

export const SourceStatus = Schema.Struct({
  id: Schema.String,
  plugin: Schema.String,
  listing: Schema.Literals(["pending", "ok", "failed"]),
  error: Schema.NullOr(Schema.String),
  streams: Schema.Array(StreamStatus),
});

const ViewCounts = {
  conversations: Schema.Int,
  unread: Schema.Int,
  open: Schema.Int,
};

export const TagStatus = Schema.Struct({
  name: Schema.String,
  ai: Schema.Boolean,
  ai_since: Schema.NullOr(Schema.String),
  ...ViewCounts,
});

export const DigestJob = Schema.Struct({
  conversation_id: Schema.Int,
  from_seq: Schema.Int,
  to_seq: Schema.Int,
  trigger: Trigger,
});

export const DigestRun = Schema.Struct({
  ...DigestJob.fields,
  at: Schema.String,
  ms: Schema.Int,
  ok: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  log_path: Schema.NullOr(Schema.String),
});
export type DigestRun = typeof DigestRun.Type;

export const Status = Schema.Struct({
  home: Schema.String,
  config: Schema.Struct({
    path: Schema.String,
    loaded_at: Schema.String,
    error: Schema.NullOr(ConfigProblem),
  }),
  sync: Schema.Literals(["running", "stopped"]),
  sources: Schema.Array(SourceStatus),
  tags: Schema.Array(TagStatus),
  untagged: Schema.Struct(ViewCounts),
  digest: Schema.NullOr(
    Schema.Struct({
      ai: Schema.String,
      threshold: Schema.Int,
      running: Schema.Array(DigestJob),
      queued: Schema.Array(DigestJob),
      last_run: Schema.NullOr(
        Schema.Struct({
          at: Schema.String,
          written: Schema.Int,
          failed: Schema.Int,
          avg_ms: Schema.NullOr(Schema.Int),
        }),
      ),
    }),
  ),
});
export type Status = typeof Status.Type;

export const ConversationSummary = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  title: Schema.String,
  last_at: Schema.String,
});
export type ConversationSummary = typeof ConversationSummary.Type;

export const Row = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  title: Schema.String,
  tags: Schema.Array(Schema.String),
  first_at: Schema.String,
  last_at: Schema.String,
  last_seq: Schema.Int,
  seen_seq: Schema.Int,
  cleared_seq: Schema.Int,
  muted: Schema.Boolean,
  state: ConversationState,
  new: Schema.Int,
  items: Schema.Int,
  participants: Schema.Int,
  from: RowParty,
  preview: Schema.String,
  senders: Schema.Array(RowParty),
});
export type Row = typeof Row.Type;

const Segment = Schema.Struct({ text: Schema.String, mark: Schema.Boolean });

export const Line = Schema.Struct({
  field: Schema.Literals(["topic", "body", "from", "source", "headline"]),
  seq: Schema.NullOr(Schema.Int),
  digest_id: Schema.NullOr(Schema.Int),
  title: Schema.NullOr(Schema.Array(Segment)),
  text: Schema.Array(Segment),
});
export type Line = typeof Line.Type;

export const SearchResult = Schema.Struct({
  conversations: Schema.Array(Schema.Struct({ ...Row.fields, hits: Schema.Array(Line) })),
});
export type SearchResult = typeof SearchResult.Type;

export const ItemSummary = Schema.Struct({
  seq: Schema.Int,
  occurred_at: Schema.String,
  from: Party,
  from_me: Schema.Boolean,
  title: Schema.NullOr(Schema.String),
  body_new: Schema.String,
});

export const DigestGap = Schema.Struct({
  from_seq: Schema.Int,
  to_seq: Schema.Int,
  items: Schema.Int,
  run_items: Schema.Int,
});
export type DigestGap = typeof DigestGap.Type;

export const Conversation = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  title: Schema.String,
  first_at: Schema.String,
  last_at: Schema.String,
  tags: Schema.Array(Schema.String),
  open: Schema.NullOr(Schema.Struct({ label: Schema.String, link: Schema.String })),
  state: Schema.Struct({
    seen_seq: Schema.Int,
    cleared_seq: Schema.Int,
    muted: Schema.Boolean,
    state: ConversationState,
  }),
  items: Schema.Array(ItemSummary),
  digests: Schema.Array(Digest),
  digest: Schema.Struct({
    backlog: Schema.NullOr(Schema.Struct({ chars: Schema.Int, threshold: Schema.Int })),
    earlier: Schema.NullOr(
      Schema.Array(Schema.Struct({ before_digest: Schema.Int, ...DigestGap.fields })),
    ),
    now: Schema.NullOr(DigestGap),
    last_failure: Schema.NullOr(DigestRun),
  }),
});

export const Item = Schema.Struct({
  seq: Schema.Int,
  conversation_id: Schema.Int,
  container_name: Schema.String,
  occurred_at: Schema.String,
  title: Schema.NullOr(Schema.String),
  from: Party,
  from_me: Schema.Boolean,
  link: Schema.NullOr(Schema.String),
  body: Schema.String,
  body_new: Schema.String,
  raw: Schema.Unknown,
  deleted_at: Schema.NullOr(Schema.String),
});

export const Hits = Schema.Struct({ conversations: Schema.Int, items: Schema.Int });

export const TagHits = Schema.Struct({
  name: Schema.String,
  conversations: Schema.Int,
  items: Schema.Int,
  samples: Schema.Array(ConversationSummary),
});

export const TagTest = Schema.Struct({
  config: Schema.String,
  tags: Schema.Array(TagHits),
  untagged: Hits,
  total: Hits,
});
export type TagTest = typeof TagTest.Type;

export const Reloaded = Schema.Struct({
  loaded_at: Schema.String,
  sources: Schema.Array(Schema.String),
  tags: Schema.Array(Schema.String),
});

export class WeirGroup extends HttpApiGroup.make("weir", { topLevel: true }).add(
  HttpApiEndpoint.get("status", "/status", { success: Status }),
  HttpApiEndpoint.get("search", "/search", {
    query: {
      q: Schema.String,
      tag: Schema.optionalKey(Schema.String),
      source: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(Schema.String),
      since: Schema.optionalKey(DurationShorthand),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    },
    success: SearchResult,
  }),
  HttpApiEndpoint.get("conversation", "/conversations/:id", {
    params: { id: Schema.Int },
    success: Conversation,
    error: NotFound,
  }),
  HttpApiEndpoint.get("item", "/items/:seq", {
    params: { seq: Schema.Int },
    success: Item,
    error: NotFound,
  }),
  HttpApiEndpoint.get("tagTest", "/tags/test", {
    query: { name: Schema.optionalKey(Schema.String) },
    success: TagTest,
    error: [ConfigInvalid, NotFound],
  }),
  HttpApiEndpoint.post("reload", "/reload", { success: Reloaded, error: ConfigInvalid }),
) {}

const UntaggedView = Schema.Literal("untagged").pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Untagged", {}),
    SchemaTransformation.transform({
      decode: () => ({ _tag: "Untagged" as const }),
      encode: () => "untagged" as const,
    }),
  ),
);

const tagPrefix = "tag:";

const TagView = Schema.TemplateLiteral([tagPrefix, Schema.String]).pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Tag", { name: Schema.String.check(Schema.isNonEmpty()) }),
    SchemaTransformation.transform({
      decode: (text) => ({ _tag: "Tag" as const, name: text.slice(tagPrefix.length) }),
      encode: ({ name }) => `${tagPrefix}${name}` as const,
    }),
  ),
);

const ClearedView = Schema.Literal("cleared").pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Cleared", {}),
    SchemaTransformation.transform({
      decode: () => ({ _tag: "Cleared" as const }),
      encode: () => "cleared" as const,
    }),
  ),
);

export const ClearableView = Schema.Union([UntaggedView, TagView]);
export type ClearableView = typeof ClearableView.Type;

export const View = Schema.Union([UntaggedView, TagView, ClearedView]);
export type View = typeof View.Type;

export const ViewList = Schema.Struct({ seq: Schema.Int, conversations: Schema.Array(Row) });

const viewSummary = {
  unread: Schema.Int,
  open: Schema.Int,
  senders: Schema.Array(Party),
};

export const Counts = Schema.Struct({
  unread: Schema.Int,
  tags: Schema.Array(Schema.Struct({ name: Schema.String, ...viewSummary })),
  untagged: Schema.Struct(viewSummary),
  cleared: Schema.Int,
});
export type Counts = typeof Counts.Type;

export class ViewGroup extends HttpApiGroup.make("view", { topLevel: true }).add(
  HttpApiEndpoint.get("conversations", "/conversations", {
    query: { view: View },
    success: ViewList,
    error: NotFound,
  }),
  HttpApiEndpoint.get("counts", "/counts", { success: Counts }),
) {}

const conversationParams = { id: Schema.Int };

export class StateGroup extends HttpApiGroup.make("state", { topLevel: true }).add(
  HttpApiEndpoint.post("read", "/conversations/:id/read", {
    params: conversationParams,
    payload: Schema.Struct({ seq: Schema.Int }),
    success: Row,
    error: NotFound,
  }),
  HttpApiEndpoint.post("unread", "/conversations/:id/unread", {
    params: conversationParams,
    payload: Schema.Struct({ seq: Schema.optionalKey(Schema.Int) }),
    success: Row,
    error: NotFound,
  }),
  HttpApiEndpoint.post("done", "/conversations/:id/done", {
    params: conversationParams,
    payload: Schema.Struct({ seq: Schema.Int }),
    success: Row,
    error: NotFound,
  }),
  HttpApiEndpoint.post("mute", "/conversations/:id/mute", {
    params: conversationParams,
    success: Row,
    error: NotFound,
  }),
  HttpApiEndpoint.post("restore", "/conversations/:id/restore", {
    params: conversationParams,
    success: Row,
    error: NotFound,
  }),
  HttpApiEndpoint.post("clear", "/clear", {
    payload: Schema.Struct({ view: ClearableView, seq: Schema.Int }),
    success: Schema.Struct({ cleared: Schema.Int }),
    error: NotFound,
  }),
) {}

export class DigestConflict extends Schema.TaggedError<DigestConflict>()(
  "DigestConflict",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export class DigestFailed extends Schema.TaggedError<DigestFailed>()(
  "DigestFailed",
  { error: Schema.String, log_path: Schema.NullOr(Schema.String) },
  { httpApiStatus: 502 },
) {}

export class DigestInterrupted extends Schema.TaggedError<DigestInterrupted>()(
  "DigestInterrupted",
  { message: Schema.String },
  { httpApiStatus: 503 },
) {}

export const DigestList = Schema.Struct({ digests: Schema.Array(Digest) });

export class DigestGroup extends HttpApiGroup.make("digest", { topLevel: true }).add(
  HttpApiEndpoint.post("digest", "/conversations/:id/digest", {
    params: conversationParams,
    payload: Schema.Struct({
      from: Schema.optionalKey(Schema.Int),
      up_to: Schema.optionalKey(Schema.Int),
    }).check(
      Schema.makeFilter(
        (payload: { readonly from?: number; readonly up_to?: number }) =>
          payload.from === undefined ||
          payload.up_to === undefined ||
          "from and up_to are exclusive",
      ),
    ),
    success: DigestList,
    error: [NotFound, DigestConflict, DigestFailed, DigestInterrupted],
  }),
  HttpApiEndpoint.post("redo", "/digests/:id/redo", {
    params: { id: Schema.Int },
    success: DigestList,
    error: [NotFound, DigestConflict, DigestFailed, DigestInterrupted],
  }),
) {}

export const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({
    type: Schema.Literal("sync"),
    source: Schema.String,
    status: Schema.Literals(["started", "done", "failed"]),
    error: Schema.optionalKey(Schema.String),
    at: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("digest"),
    conversation_id: Schema.Int,
    from_seq: Schema.Int,
    to_seq: Schema.Int,
    trigger: Trigger,
    status: Schema.Literals(["queued", "running", "done", "failed"]),
    error: Schema.optionalKey(Schema.String),
    log_path: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("state"), ids: Schema.Array(Schema.Int) }),
  Schema.Struct({
    type: Schema.Literal("reload"),
    status: Schema.Literal("ok"),
    at: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("reload"),
    status: Schema.Literal("failed"),
    error: ConfigProblem,
    at: Schema.String,
  }),
]);
export type Event = typeof Event.Type;

export class EventsGroup extends HttpApiGroup.make("events", { topLevel: true }).add(
  HttpApiEndpoint.get("events", "/events", { success: HttpApiSchema.StreamSse({ data: Event }) }),
) {}

export class Api extends HttpApi.make("weir").add(
  WeirGroup,
  ViewGroup,
  StateGroup,
  DigestGroup,
  EventsGroup,
) {}
