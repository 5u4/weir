import { dirname, resolve } from "node:path";
import { type Config, decodeConfig } from "@weir/contract/Config";
import type { Settings } from "@weir/digest/Digester";
import {
  formatConfigPath,
  loadSources,
  type PluginRegistry,
  type ScheduledSource,
} from "@weir/sync/Scheduler";
import { errorMessage } from "@weir/sync/Sync";
import * as Effect from "effect/Effect";
import * as SchemaIssue from "effect/SchemaIssue";
import { ConfigInvalid } from "./Api.ts";

export interface Loaded {
  readonly config: Config;
  readonly sources: ReadonlyArray<ScheduledSource>;
  readonly digest: Settings | null;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const read = Effect.fnUntraced(function* (file: string) {
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: (cause) =>
      ConfigInvalid.fromIssues(file, [
        { path: "", message: `cannot read: ${errorMessage(cause)}` },
      ]),
  });
  const parsed = yield* Effect.try({
    try: () => Bun.TOML.parse(text),
    catch: (cause) =>
      ConfigInvalid.fromIssues(file, [
        { path: "", message: `invalid TOML: ${errorMessage(cause)}` },
      ]),
  });
  return yield* decodeConfig(parsed).pipe(
    Effect.mapError((error) =>
      ConfigInvalid.fromIssues(
        file,
        formatIssues(error.issue).issues.map(({ path, message }) => ({
          path: formatConfigPath(
            (path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)),
          ),
          message,
        })),
      ),
    ),
  );
});

export const load = Effect.fnUntraced(function* (
  file: string,
  registry: PluginRegistry,
): Effect.fn.Return<Loaded, ConfigInvalid> {
  const config = yield* read(file);
  const sources = yield* loadSources(config.source, registry).pipe(
    Effect.mapError((error) => ConfigInvalid.fromIssues(file, error.issues)),
  );
  const { digest, ai } = config;
  const profile = digest === undefined ? undefined : ai?.[digest.ai];
  if (digest === undefined || profile === undefined) return { config, sources, digest: null };
  const guidePath = digest.guide === undefined ? null : resolve(dirname(file), digest.guide);
  const guide =
    guidePath === null
      ? null
      : yield* Effect.tryPromise({
          try: () => Bun.file(guidePath).text(),
          catch: (cause) =>
            ConfigInvalid.fromIssues(file, [
              {
                path: formatConfigPath(["digest", "guide"]),
                message: `cannot read ${guidePath}: ${errorMessage(cause)}`,
              },
            ]),
        });
  return {
    config,
    sources,
    digest: { ai: digest.ai, profile, digest, guide },
  };
});
