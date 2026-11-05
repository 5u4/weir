import type { Status } from "@weir/daemon/Api";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";
import { ago, alertOf, configState, dayLabel, health } from "./Health.ts";

const stream = (overrides: Partial<Status["sources"][number]["streams"][number]> = {}) => ({
  name: "robin@example.com",
  kind: "message",
  last_sync_at: "2026-10-25T16:00:00.000Z",
  last_ok_at: "2026-10-25T16:00:00.000Z",
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
  version: "0.1.0",
  config: { path: "/h/config.toml", loaded_at: "2026-10-25T16:00:00.000Z", error: configError },
  sync: configError === null ? "running" : "stopped",
  sources,
  tags: [],
  untagged: { conversations: 0, unread: 0, open: 0 },
  ai: [],
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
  it("raises no alert while every source syncs", () => {
    const value = status([
      source("work", { streams: [stream({ last_sync_at: "2026-10-25T15:00:00.000Z" })] }),
      source("home", { streams: [stream({ last_sync_at: "2026-10-25T16:30:00.000Z" })] }),
    ]);
    expect(alertOf(value)).toEqual(Option.none());
    expect(health(value).sources.map(({ state }) => state._tag)).toEqual(["Synced", "Synced"]);
  });

  it("alerts on every failing source, in order, since its last successful sync", () => {
    const value = status([
      source("work"),
      source("home", {
        streams: [
          stream({
            last_sync_at: "2026-10-25T16:00:00.000Z",
            last_ok_at: "2026-10-25T10:00:00.000Z",
            last_error: "invalid_grant",
          }),
        ],
      }),
      source("chat", { listing: "failed", error: "gws not found", streams: [] }),
    ]);
    expect(alertOf(value)).toEqual(
      Option.some({
        _tag: "SourcesFailed",
        sources: [
          { id: "home", since: DateTime.makeUnsafe("2026-10-25T10:00:00.000Z") },
          { id: "chat", since: null },
        ],
      }),
    );
    expect(health(value).sources.map(({ state }) => state)).toEqual([
      { _tag: "Synced", at: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z") },
      {
        _tag: "Failed",
        error: "invalid_grant",
        tried: DateTime.makeUnsafe("2026-10-25T16:00:00.000Z"),
      },
      { _tag: "Failed", error: "gws not found", tried: null },
    ]);
  });

  it("a source fails from the oldest success among its failing streams", () => {
    const value = status([
      source("work", {
        streams: [
          stream({ name: "inbox", last_ok_at: "2026-10-25T09:00:00.000Z", last_error: "boom" }),
          stream({ name: "chat", last_ok_at: "2026-10-25T07:00:00.000Z", last_error: "boom" }),
          stream({ name: "drafts", last_ok_at: "2026-10-25T01:00:00.000Z" }),
        ],
      }),
    ]);
    expect(alertOf(value)).toEqual(
      Option.some({
        _tag: "SourcesFailed",
        sources: [{ id: "work", since: DateTime.makeUnsafe("2026-10-25T07:00:00.000Z") }],
      }),
    );
  });

  it("a config error stops everything and outranks a failing source", () => {
    const error = { file: "/h/config.toml", message: "invalid config", issues: [] };
    const value = status([source("home", { streams: [stream({ last_error: "boom" })] })], error);
    expect(health(value).stopped).toBe(true);
    expect(alertOf(value)).toEqual(Option.some({ _tag: "ConfigStopped", error }));
  });

  it("a source still listing or never synced is not a failure", () => {
    const value = status([
      source("new", { listing: "pending", streams: [] }),
      source("idle", { streams: [stream({ last_sync_at: null, last_ok_at: null })] }),
    ]);
    expect(alertOf(value)).toEqual(Option.none());
    expect(health(value).sources.map(({ state }) => state._tag)).toEqual(["Starting", "NotSynced"]);
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
          tried: DateTime.makeUnsafe("2026-10-25T10:00:00.000Z"),
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

describe("day label", () => {
  const at = DateTime.makeUnsafe(new Date(2026, 9, 15, 12));
  it.each([
    [0, "Today"],
    [1, "Yesterday"],
    [5, "Thu, Oct 15"],
  ])("%d days later reads %s", (days, expected) => {
    expect(dayLabel(at, DateTime.add(at, { days }))).toBe(expected);
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
