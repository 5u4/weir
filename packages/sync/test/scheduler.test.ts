import { describe, expect, it } from "@effect/vitest";
import { decodeConfig } from "@weir/contract/Config";
import type { SourcePlugin } from "@weir/contract/Source";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { loadSources, type PluginRegistry, run } from "../src/Scheduler.ts";
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

const failingPlugin: SourcePlugin<unknown> = {
  id: "failing",
  configSchema: Schema.toStandardSchemaV1(Schema.Unknown),
  create: () => ({
    streams: async () => {
      throw new Error("gws: not logged in");
    },
    sync: async () => {
      throw new Error("unreachable");
    },
  }),
};

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

describe("loadSources", () => {
  it.effect("reports the config path of every invalid source", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const registry: PluginRegistry = { fake: fakePlugin(calls) };
      const parsed = yield* config([
        { id: "a", plugin: "fake", sync_every: "5m", config: { command: ["ok"] } },
        { id: "b", plugin: "missing", sync_every: "5m", config: {} },
        { id: "c", plugin: "fake", sync_every: "5m", config: { command: "fake-cli" } },
        { id: "d", plugin: "toString", sync_every: "5m", config: {} },
      ]);
      const error = yield* Effect.flip(loadSources(parsed.source, registry));
      expect(error.issues.map(({ path }) => path)).toEqual([
        '["source"][1]["plugin"]',
        '["source"][2]["config"]["command"]',
        '["source"][3]["plugin"]',
      ]);
    }),
  );
});

describe("run", () => {
  it.effect("syncs each source immediately, then every sync_every, reporting each listing", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const reports: Array<[string, string | null]> = [];
      const parsed = yield* config(
        [
          { id: "a", plugin: "fake", sync_every: "5m", config: { command: ["fake-cli"] } },
          { id: "b", plugin: "failing", sync_every: "5m", config: {} },
        ],
        [{ name: "greeting", match: { type: "eq", target: "/title", is: "hello" } }],
      );
      const sources = yield* loadSources(parsed.source, {
        fake: fakePlugin(calls),
        failing: failingPlugin,
      });
      const fiber = yield* Effect.forkChild(
        run(
          sources,
          parsed.tag,
          (id, error) => Effect.sync(() => reports.push([id, error])),
          () => Effect.void,
        ),
      );
      yield* awaitSyncRuns(1);
      yield* settle;
      expect(calls).toEqual([["fake-cli"]]);
      expect(yield* syncRunCount).toBe(1);
      expect(reports.toSorted()).toEqual([
        ["a", null],
        ["b", "gws: not logged in"],
      ]);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT tag FROM conversation_tag`).toEqual([{ tag: "greeting" }]);

      yield* TestClock.adjust("4 minutes");
      yield* settle;
      expect(yield* syncRunCount).toBe(1);

      yield* TestClock.adjust("1 minute");
      yield* awaitSyncRuns(2);
      expect(yield* syncRunCount).toBe(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(storeLayer())),
  );
});
