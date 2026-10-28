import type { Config, SourceConfig } from "@weir/contract/Config";
import type { Source, SourcePlugin } from "@weir/contract/Source";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { syncSource } from "./Sync.ts";
import { recomputeAllTags } from "./Tags.ts";

export type PluginRegistry = Readonly<Record<string, SourcePlugin<unknown>>>;

export const ConfigIssue = Schema.Struct({ path: Schema.String, message: Schema.String });
export type ConfigIssue = typeof ConfigIssue.Type;

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  issues: Schema.Array(ConfigIssue),
}) {}

export interface ScheduledSource {
  readonly id: string;
  readonly every: Duration.Duration;
  readonly source: Source;
}

const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path.map((key) => (typeof key === "number" ? `[${key}]` : `[${JSON.stringify(key)}]`)).join("");

export const loadSources = Effect.fnUntraced(function* (
  sources: ReadonlyArray<SourceConfig>,
  registry: PluginRegistry,
) {
  const issues: Array<ConfigIssue> = [];
  const loaded: Array<ScheduledSource> = [];
  for (const [index, config] of sources.entries()) {
    const plugin = Object.hasOwn(registry, config.plugin) ? registry[config.plugin] : undefined;
    if (plugin === undefined) {
      issues.push({
        path: formatPath(["source", index, "plugin"]),
        message: `unknown plugin "${config.plugin}"`,
      });
      continue;
    }
    const result = yield* Effect.promise(async () =>
      plugin.configSchema["~standard"].validate(config.config),
    );
    if (result.issues !== undefined) {
      for (const issue of result.issues) {
        issues.push({
          path: formatPath([
            "source",
            index,
            "config",
            ...(issue.path ?? []).map((segment) =>
              typeof segment === "object" ? segment.key : segment,
            ),
          ]),
          message: issue.message,
        });
      }
      continue;
    }
    loaded.push({ id: config.id, every: config.sync_every, source: plugin.create(result.value) });
  }
  if (issues.length > 0) {
    return yield* new ConfigError({
      message: issues.map(({ path, message }) => `${message}\n  at ${path}`).join("\n"),
      issues,
    });
  }
  return loaded;
});

export const run = Effect.fnUntraced(function* (config: Config, registry: PluginRegistry) {
  const sources = yield* loadSources(config.source, registry);
  yield* recomputeAllTags(config.tag);
  return yield* Effect.forEach(
    sources,
    ({ id, every, source }) =>
      syncSource(id, source, config.tag).pipe(
        Effect.catch((error) => Effect.logError(`sync of ${id} failed`, error)),
        Effect.repeat(Schedule.spaced(every)),
      ),
    { concurrency: "unbounded", discard: true },
  );
});
