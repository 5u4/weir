import { describe, expect, it } from "@effect/vitest";
import { decodeConfig } from "@weir/contract/Config";
import type { SourcePlugin } from "@weir/contract/Source";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { type PluginRegistry, run } from "../src/Scheduler.ts";
import { page, rawItem, scriptedSource, storeLayer } from "./fixtures.ts";

const FakeConfig = Schema.Struct({ command: Schema.NonEmptyArray(Schema.String) });

const fakePlugin = (calls: Array<ReadonlyArray<string>>): SourcePlugin<typeof FakeConfig.Type> => ({
  id: "fake",
  configSchema: Schema.toStandardSchemaV1(FakeConfig),
  create: (config) => {
    calls.push(config.command);
    return scriptedSource(
      new Map([
        [null, page({ cursor: "c1", upserts: [rawItem("m1", { title: "hello" })] })],
        ["c1", page({ cursor: "c1" })],
      ]),
    ).source;
  },
});

const config = (source: ReadonlyArray<unknown>, tag: ReadonlyArray<unknown> = []) =>
  decodeConfig({ source, tag });

const syncRunCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ count: number }>`SELECT count(*) AS count FROM sync_run`;
  return row?.count ?? 0;
});

const settle = TestClock.withLive(Effect.sleep("50 millis"));

const awaitSyncRuns = (expected: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((yield* syncRunCount) >= expected) return;
      yield* TestClock.withLive(Effect.sleep("5 millis"));
    }
  });

describe("run", () => {
  it.effect("reports the config path of every invalid source before syncing anything", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const registry: PluginRegistry = { fake: fakePlugin(calls) };
      const error = yield* Effect.flip(
        run(
          yield* config([
            { id: "a", plugin: "fake", sync_every: "5m", config: { command: ["ok"] } },
            { id: "b", plugin: "missing", sync_every: "5m", config: {} },
            { id: "c", plugin: "fake", sync_every: "5m", config: { command: "fake-cli" } },
            { id: "d", plugin: "toString", sync_every: "5m", config: {} },
          ]),
          registry,
        ),
      );
      expect(error._tag).toBe("ConfigError");
      if (error._tag !== "ConfigError") return;
      expect(error.issues.map(({ path }) => path)).toEqual([
        '["source"][1]["plugin"]',
        '["source"][2]["config"]["command"]',
        '["source"][3]["plugin"]',
      ]);
      expect(yield* syncRunCount).toBe(0);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("syncs each source immediately, then every sync_every", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const fiber = yield* Effect.forkChild(
        run(
          yield* config(
            [{ id: "a", plugin: "fake", sync_every: "5m", config: { command: ["fake-cli"] } }],
            [{ name: "greeting", match: { type: "eq", target: "/title", is: "hello" } }],
          ),
          { fake: fakePlugin(calls) },
        ),
      );
      yield* awaitSyncRuns(1);
      expect(calls).toEqual([["fake-cli"]]);
      expect(yield* syncRunCount).toBe(1);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT tag FROM conversation_tag`).toEqual([{ tag: "greeting" }]);

      yield* settle;
      yield* TestClock.adjust("4 minutes");
      yield* settle;
      expect(yield* syncRunCount).toBe(1);

      yield* TestClock.adjust("1 minute");
      yield* awaitSyncRuns(2);
      expect(yield* syncRunCount).toBe(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("recomputes every conversation's tags from the config on start", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fiber = yield* Effect.forkChild(
        run(
          yield* config([
            { id: "a", plugin: "fake", sync_every: "5m", config: { command: ["fake-cli"] } },
          ]),
          { fake: fakePlugin([]) },
        ),
      );
      yield* awaitSyncRuns(1);
      yield* Fiber.interrupt(fiber);
      yield* sql`INSERT INTO conversation_tag (conversation_id, tag) SELECT id, 'stale' FROM conversation`;

      const restarted = yield* Effect.forkChild(
        run(
          yield* config(
            [{ id: "a", plugin: "fake", sync_every: "5m", config: { command: ["fake-cli"] } }],
            [{ name: "a-source", match: { type: "eq", target: "/source", is: "a" } }],
          ),
          { fake: fakePlugin([]) },
        ),
      );
      yield* awaitSyncRuns(2);
      yield* Fiber.interrupt(restarted);
      expect(yield* sql`SELECT tag FROM conversation_tag`).toEqual([{ tag: "a-source" }]);
    }).pipe(Effect.provide(storeLayer())),
  );
});
