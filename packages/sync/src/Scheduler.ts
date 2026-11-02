import type { SourceConfig } from "@weir/contract/Config";
import type { Source, SourcePlugin } from "@weir/contract/Source";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { Groups } from "./Groups.ts";
import { errorMessage, syncSource, type Written } from "./Sync.ts";
import type { Tags } from "./Tags.ts";

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

export const formatConfigPath = (path: ReadonlyArray<PropertyKey>) =>
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
        path: formatConfigPath(["source", index, "plugin"]),
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
          path: formatConfigPath([
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

export type SyncOutcome =
  | { readonly listing: "failed"; readonly error: string }
  | { readonly listing: "ok"; readonly streamErrors: ReadonlyArray<string> };

export const run = (
  sources: ReadonlyArray<ScheduledSource>,
  tags: Tags,
  groups: Groups,
  onStarted: (sourceId: string) => Effect.Effect<void>,
  report: (sourceId: string, outcome: SyncOutcome) => Effect.Effect<void>,
  onWritten: Written,
) =>
  Effect.forEach(
    sources,
    ({ id, every, source }) =>
      onStarted(id).pipe(
        Effect.andThen(syncSource(id, source, tags, groups, onWritten)),
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logError(`sync of ${id} failed`, cause).pipe(
                  Effect.andThen(
                    report(id, { listing: "failed", error: errorMessage(Cause.squash(cause)) }),
                  ),
                ),
          onSuccess: (streamErrors) => report(id, { listing: "ok", streamErrors }),
        }),
        Effect.repeat(Schedule.spaced(every)),
      ),
    { concurrency: "unbounded", discard: true },
  );
