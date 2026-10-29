import type { Status } from "@weir/daemon/Api";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";
import { ago, configState, health } from "./Health.ts";

const stream = (overrides: Partial<Status["sources"][number]["streams"][number]> = {}) => ({
  name: "robin@example.com",
  kind: "message",
  last_sync_at: "2026-10-25T16:00:00.000Z",
  last_error: null,
  backfill: "done" as const,
  items: 12,
  ...overrides,
});

const status = (
  sources: Status["sources"],
  configError: Status["config"]["error"] = null,
): Status => ({
  home: "/h",
  config: { path: "/h/config.toml", loaded_at: "2026-10-25T16:00:00.000Z", error: configError },
  sync: configError === null ? "running" : "stopped",
  sources,
  tags: [],
  untagged: { conversations: 0, unread: 0, open: 0 },
  digest: null,
});

const source = (id: string, overrides: Partial<Status["sources"][number]> = {}) => ({
  id,
  plugin: "gws",
  listing: "ok" as const,
  error: null,
  streams: [stream()],
  ...overrides,
});

describe("status health", () => {
  it("is running with the latest stream sync across sources", () => {
    const result = health(
      status([
        source("work", { streams: [stream({ last_sync_at: "2026-10-25T15:00:00.000Z" })] }),
        source("home", { streams: [stream({ last_sync_at: "2026-10-25T16:30:00.000Z" })] }),
      ]),
    );
    expect(result.alert).toBe(false);
    expect(result.verdict).toEqual({
      _tag: "Running",
      lastSync: DateTime.makeUnsafe("2026-10-25T16:30:00.000Z"),
    });
  });

  it("names the first failing source; a stream error fails it and keeps the last good sync", () => {
    const result = health(
      status([
        source("work"),
        source("home", {
          streams: [
            stream({ last_sync_at: "2026-10-25T10:00:00.000Z", last_error: "invalid_grant" }),
          ],
        }),
        source("chat", { listing: "failed", error: "gws not found", streams: [] }),
      ]),
    );
    expect(result.alert).toBe(true);
    expect(result.verdict).toEqual({ _tag: "SourceDown", source: "home" });
    expect(result.sources.map(({ state }) => state)).toEqual([
      { _tag: "Synced", at: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z") },
      {
        _tag: "Failed",
        error: "invalid_grant",
        lastGood: DateTime.makeUnsafe("2026-10-25T10:00:00.000Z"),
      },
      { _tag: "Failed", error: "gws not found", lastGood: null },
    ]);
  });

  it("a config error stops everything and outranks a failing source", () => {
    const result = health(
      status([source("home", { streams: [stream({ last_error: "boom" })] })], {
        file: "/h/config.toml",
        message: "invalid config",
        issues: [],
      }),
    );
    expect(result.stopped).toBe(true);
    expect(result.verdict).toEqual({ _tag: "Stopped" });
  });

  it("a source still listing or never synced is not a failure", () => {
    const result = health(
      status([
        source("new", { listing: "pending", streams: [] }),
        source("idle", { streams: [stream({ last_sync_at: null })] }),
      ]),
    );
    expect(result.alert).toBe(false);
    expect(result.sources.map(({ state }) => state._tag)).toEqual(["Starting", "NotSynced"]);
    expect(result.verdict).toEqual({ _tag: "Running", lastSync: null });
  });

  it("keeps each stream's own sync time, items and error", () => {
    const result = health(
      status([
        source("work", {
          streams: [
            stream({ name: "inbox", items: 12, backfill: "running" }),
            stream({
              name: "chat",
              kind: "chat",
              items: 3,
              last_sync_at: "2026-10-25T10:00:00.000Z",
              last_error: "rate limited",
            }),
            stream({ name: "drafts", items: 0, last_sync_at: null }),
          ],
        }),
      ]),
    );
    expect(result.sources[0]?.streams).toEqual([
      {
        name: "inbox",
        state: { _tag: "Synced", at: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z") },
        items: 12,
        backfilling: true,
      },
      {
        name: "chat",
        state: {
          _tag: "Failed",
          error: "rate limited",
          lastGood: DateTime.makeUnsafe("2026-10-25T10:00:00.000Z"),
        },
        items: 3,
        backfilling: false,
      },
      { name: "drafts", state: { _tag: "NotSynced" }, items: 0, backfilling: false },
    ]);
  });
});

describe("relative time", () => {
  const at = DateTime.makeUnsafe("2026-10-25T16:00:00.000Z");
  it.each([
    [30, "just now"],
    [60 * 59, "59m ago"],
    [3600 * 5, "5h ago"],
    [86400 * 3, "3d ago"],
  ])("%ds later reads %s", (seconds, expected) => {
    expect(ago(at, DateTime.add(at, { seconds }))).toBe(expected);
  });
});

describe("config state", () => {
  const loaded = { path: "/h/config.toml", loaded_at: "2026-10-25T16:00:00.000Z", error: null };
  const problem = { file: "/h/config.toml", message: "invalid config", issues: [] };
  const invalid = { ...loaded, error: problem };
  const loadedAt = { _tag: "Loaded", at: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z") };
  const transport = AsyncResult.failure<void, never>(
    Cause.die(new Error("Transport error (POST /reload)")),
  );

  it.each([
    ["before any Reload, a loaded snapshot", AsyncResult.initial(), loaded, loadedAt],
    [
      "before any Reload, an invalid snapshot",
      AsyncResult.initial(),
      invalid,
      { _tag: "Invalid", problem },
    ],
    ["after a Reload, a snapshot loaded since", AsyncResult.success(undefined), loaded, loadedAt],
    [
      "after a Reload, a snapshot invalid since",
      AsyncResult.success(undefined),
      invalid,
      { _tag: "Invalid", problem },
    ],
    ["during a first Reload", AsyncResult.initial(true), loaded, { _tag: "Reloading" }],
    [
      "during a later Reload",
      AsyncResult.success(undefined, { waiting: true }),
      invalid,
      { _tag: "Reloading" },
    ],
    [
      "after a Reload request that failed, a loaded snapshot",
      transport,
      loaded,
      { _tag: "RequestFailed", reason: "Transport error (POST /reload)" },
    ],
  ])("%s", (_, reload, config, expected) => {
    expect(configState(reload, config)).toEqual(expected);
  });
});
