import { describe, expect, it } from "@effect/vitest";
import { decodeConfig } from "@weir/contract/Config";
import type { Source, SourcePlugin, SyncPage } from "@weir/contract/Source";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { loadSources, type PluginRegistry, run, type SyncOutcome } from "../src/Scheduler.ts";
import { mailStream, page, rawItem, scriptedSource, storeLayer } from "./fixtures.ts";

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
      const reports: Array<[string, SyncOutcome]> = [];
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
          () => Effect.void,
          (id, outcome) => Effect.sync(() => reports.push([id, outcome])),
          () => Effect.void,
        ),
      );
      yield* awaitSyncRuns(1);
      yield* settle;
      expect(calls).toEqual([["fake-cli"]]);
      expect(yield* syncRunCount).toBe(1);
      expect(reports.toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
        ["a", { listing: "ok", streamErrors: [] }],
        ["b", { listing: "failed", error: "gws: not logged in" }],
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

  it.effect(
    "an interrupted pass aborts the in-flight page, keeps written pages, records nothing",
    () =>
      Effect.gen(function* () {
        const calls: Array<string | null> = [];
        const aborted: Array<string | null> = [];
        const reports: Array<[string, SyncOutcome]> = [];
        let hang = true;
        const source: Source = {
          streams: async () => [mailStream],
          sync: (_streamId, cursor, signal) => {
            calls.push(cursor);
            if (cursor === null)
              return Promise.resolve(
                page({ cursor: "c1", more: true, backfill: "running", upserts: [rawItem("m1")] }),
              );
            if (!hang) return Promise.resolve(page({ cursor: "c2", upserts: [rawItem("m2")] }));
            const { promise, reject } = Promise.withResolvers<SyncPage>();
            signal.addEventListener("abort", () => {
              aborted.push(cursor);
              reject(signal.reason);
            });
            return promise;
          },
        };
        const pass = run(
          [{ id: "a", every: Duration.minutes(5), source }],
          [],
          () => Effect.void,
          (id, outcome) => Effect.sync(() => reports.push([id, outcome])),
          () => Effect.void,
        );
        const sql = yield* SqlClient.SqlClient;
        const stored = Effect.all({
          items: sql<{ externalId: string }>`SELECT external_id FROM item ORDER BY seq`,
          cursors: sql<{ cursor: string }>`SELECT cursor FROM stream`,
        });

        const first = yield* Effect.forkChild(pass);
        for (let attempt = 0; attempt < 100 && calls.length < 2; attempt++) {
          yield* TestClock.withLive(Effect.sleep("5 millis"));
        }
        yield* Fiber.interrupt(first);
        expect(aborted).toEqual(["c1"]);
        expect(reports).toEqual([]);
        expect(yield* syncRunCount).toBe(0);
        expect(yield* stored).toEqual({
          items: [{ externalId: "m1" }],
          cursors: [{ cursor: "c1" }],
        });

        hang = false;
        const second = yield* Effect.forkChild(pass);
        yield* awaitSyncRuns(1);
        expect(calls.slice(2)).toEqual(["c1"]);
        expect(reports).toEqual([["a", { listing: "ok", streamErrors: [] }]]);
        expect(yield* stored).toEqual({
          items: [{ externalId: "m1" }, { externalId: "m2" }],
          cursors: [{ cursor: "c2" }],
        });
        yield* Fiber.interrupt(second);
      }).pipe(Effect.provide(storeLayer())),
  );
});
