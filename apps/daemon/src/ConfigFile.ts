import { decodeConfig } from "@weir/contract/Config";
import { formatConfigPath, loadSources, type PluginRegistry } from "@weir/sync/Scheduler";
import { errorMessage } from "@weir/sync/Sync";
import * as Effect from "effect/Effect";
import * as SchemaIssue from "effect/SchemaIssue";
import { ConfigInvalid } from "./Api.ts";

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

export const load = Effect.fnUntraced(function* (file: string, registry: PluginRegistry) {
  const config = yield* read(file);
  const sources = yield* loadSources(config.source, registry).pipe(
    Effect.mapError((error) => ConfigInvalid.fromIssues(file, error.issues)),
  );
  return { config, sources };
});
