import { DurationShorthand } from "@weir/contract/Config";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

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

const Party = Schema.Struct({ name: Schema.String, address: Schema.String });

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
});
export type Status = typeof Status.Type;

export const ConversationSummary = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  title: Schema.String,
  last_at: Schema.String,
});
export type ConversationSummary = typeof ConversationSummary.Type;

export const SearchResult = Schema.Struct({ conversations: Schema.Array(ConversationSummary) });

export const ItemSummary = Schema.Struct({
  seq: Schema.Int,
  occurred_at: Schema.String,
  from: Party,
  from_me: Schema.Boolean,
  title: Schema.NullOr(Schema.String),
  body_new: Schema.String,
});

export const Conversation = Schema.Struct({
  id: Schema.Int,
  source: Schema.String,
  title: Schema.String,
  first_at: Schema.String,
  last_at: Schema.String,
  tags: Schema.Array(Schema.String),
  items: Schema.Array(ItemSummary),
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

export class Api extends HttpApi.make("weir").add(WeirGroup) {}
