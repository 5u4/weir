import type { Status } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { health } from "./Health.ts";
import { SettingsView } from "./Settings.tsx";

vi.hoisted(() => vi.stubGlobal("location", { origin: "http://weir.test", search: "" }));

type Source = Status["sources"][number];
type Stream = Source["streams"][number];

const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { hours }));

const stream = (overrides: Partial<Stream> = {}): Stream => ({
  name: "inbox",
  kind: "message",
  last_sync_at: hoursAgo(3),
  last_ok_at: hoursAgo(3),
  last_error: null,
  backfill: "done",
  items: 12,
  ...overrides,
});

const source = (overrides: Partial<Source> = {}): Source => ({
  id: "work",
  plugin: "gws",
  listing: "ok",
  error: null,
  streams: [stream()],
  ...overrides,
});

const status = (sources: ReadonlyArray<Source>): Status => ({
  home: "/h",
  version: "0.1.0",
  config: { path: "/h/config.toml", loaded_at: hoursAgo(1), error: null },
  sync: "running",
  sources: [...sources],
  tags: [],
  untagged: { conversations: 0, unread: 0, open: 0 },
  ai: [],
  digest: null,
});

const markupOf = (value: Status) =>
  renderToStaticMarkup(
    <SettingsView status={value} health={health(value)} focus={{ section: "appearance" }} />,
  );

const text = (sources: ReadonlyArray<Source>) => {
  const markup = markupOf(status(sources));
  const list = /id="sv-h-src">Sources<\/h3>([\s\S]*?)<\/section>/.exec(markup)?.[1] ?? "";
  return list
    .replace(/<\/(li|p|span|b)>/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

describe("settings sections", () => {
  it("reads Settings, then Appearance, Sources, Digests and Config", () => {
    const markup = markupOf(status([source()]));
    expect([...markup.matchAll(/<h[23][^>]*>([^<]*)<\/h[23]>/g)].map(([, title]) => title)).toEqual(
      ["Settings", "Appearance", "Sources", "Digests", "Config"],
    );
  });
});

describe("settings sources", () => {
  it.each<[string, ReadonlyArray<Source>, string]>([
    [
      "a synced stream shows its sync time",
      [source()],
      "work gws Synced 3h ago 1 stream · 12 items",
    ],
    [
      "a failed stream labels its time as the attempt",
      [source({ streams: [stream({ last_error: "rate limited" })] })],
      "work gws Sync failed 1 stream · Tried 3h ago · 12 items rate limited",
    ],
    [
      "a stream that never succeeded shows the failure without a time",
      [source({ streams: [stream({ last_sync_at: null, last_error: "gws not found" })] })],
      "work gws Sync failed 1 stream · 12 items gws not found",
    ],
    [
      "each failed stream of a multi-stream source labels its time as the attempt",
      [
        source({
          streams: [
            stream(),
            stream({ name: "chat", last_sync_at: hoursAgo(5), last_error: "rate limited" }),
          ],
        }),
      ],
      "work gws Sync failed 2 streams inbox Synced 3h ago 12 items chat Sync failed Tried 5h ago · 12 items rate limited",
    ],
    [
      "a listing failure stays visible beside a different stream failure",
      [
        source({
          listing: "failed",
          error: "invalid_grant",
          streams: [stream(), stream({ name: "chat", last_error: "rate limited" })],
        }),
      ],
      "work gws Sync failed 2 streams invalid_grant inbox Synced 3h ago 12 items chat Sync failed Tried 3h ago · 12 items rate limited",
    ],
  ])("%s", (_, sources, expected) => {
    expect(text(sources)).toBe(expected);
  });
});
