import { ConfigInvalid, type Status } from "@weir/daemon/Api";
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

describe("config state after Reload", () => {
  const loaded = { path: "/h/config.toml", loaded_at: "2026-10-25T16:00:00.000Z", error: null };
  const problem = { file: "/h/config.toml", message: "invalid config", issues: [] };
  const invalid = { ...loaded, error: problem };
  const reloaded = { loaded_at: "2026-10-25T17:00:00.000Z", sources: [], tags: [] };

  it("before any Reload, follows the status snapshot", () => {
    expect(configState(AsyncResult.initial(), loaded)).toEqual({
      _tag: "Loaded",
      at: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
    });
    expect(configState(AsyncResult.initial(), invalid)).toEqual({
      _tag: "Invalid",
      problem,
    });
  });

  it("is reloading while the request is in flight, whatever came before", () => {
    expect(configState(AsyncResult.initial(true), loaded)).toEqual({ _tag: "Reloading" });
    expect(configState(AsyncResult.success(reloaded, { waiting: true }), invalid)).toEqual({
      _tag: "Reloading",
    });
  });

  it("a successful Reload is loaded at its own time, ahead of a stale snapshot", () => {
    expect(configState(AsyncResult.success(reloaded), invalid)).toEqual({
      _tag: "Loaded",
      at: DateTime.makeUnsafe("2026-10-25T17:00:00.000Z"),
    });
  });

  it("a Reload rejected for config errors shows those errors, ahead of a stale snapshot", () => {
    expect(configState(AsyncResult.fail(new ConfigInvalid(problem)), loaded)).toEqual({
      _tag: "Invalid",
      problem,
    });
  });

  it("a Reload request that fails is a request failure, not loaded, even when the snapshot is fine", () => {
    expect(
      configState(
        AsyncResult.failure(Cause.die(new Error("Transport error (POST /reload)"))),
        loaded,
      ),
    ).toEqual({ _tag: "RequestFailed", reason: "Transport error (POST /reload)" });
  });
});
