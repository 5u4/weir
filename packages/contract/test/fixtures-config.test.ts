import { configToml } from "@weir/fixtures";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { decodeConfig } from "../src/Config.ts";

it("decodes the fixtures config with its fake-ai profile, gmail source and four tags", () => {
  const config = Effect.runSync(decodeConfig(Bun.TOML.parse(configToml())));
  expect(config.ai).toEqual({
    "fake-ai": { command: ["fake-ai"], timeout: Duration.seconds(30), concurrency: 1 },
  });
  expect(config.digest).toEqual({
    ai: "fake-ai",
    threshold: 1000,
    max_input: 24_000,
    context: 6000,
    language: "zh-CN",
  });
  expect(config.source).toEqual([
    {
      id: "gmail",
      plugin: "gws",
      sync_every: Duration.minutes(5),
      config: { command: ["fake-gws"], backfill: "newer_than:30d" },
    },
  ]);
  expect(config.tag.map(({ name, ai }) => [name, ai])).toEqual([
    ["Me", true],
    ["On-call", true],
    ["GitHub", false],
    ["Promos", false],
  ]);
});

it("decodes the fixtures config pointed at a mutable mailbox", () => {
  const config = Effect.runSync(decodeConfig(Bun.TOML.parse(configToml('/tmp/mail "box"'))));
  expect(config.source[0]?.config).toEqual({
    command: ["fake-gws", "--mailbox", '/tmp/mail "box"'],
    backfill: "newer_than:30d",
  });
});
