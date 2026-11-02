import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { decodeConfig } from "./Config.ts";

const specExample = Bun.TOML.parse(`
port = 9347

[ai.luna]
command = ["omp", "-p", "--no-tools", "--model", "gpt-6-luna"]
timeout = "180s"
concurrency = 2

[digest]
ai = "luna"
threshold = 1000
max_input = 24000
context = 6000
language = "zh-CN"
guide = "prompts/guide.md"

[[source]]
id = "personal-mail"
plugin = "gws"
sync_every = "5m"

[source.config]
command = ["gws"]
backfill = "newer_than:30d"

[[tag]]
name = "work"
ai = true
match = { type = "or", rules = [
  { type = "regex", target = "/from/address", regex = "@northwind\\\\.example$" },
  { type = "regex", target = "/title", regex = "Northwind" },
] }

[[tag]]
name = "promos"
match = { type = "some", target = "/raw/labelIds", rule = { type = "eq", target = "", is = "CATEGORY_PROMOTIONS" } }
`) as Record<string, unknown>;

const decode = (input: unknown) => Effect.runSync(decodeConfig(input));
const failure = (input: unknown) => Effect.runSync(Effect.flip(decodeConfig(input))).message;

const withTag = (tag: Record<string, unknown>) => ({ ...specExample, tag: [tag] });

describe("Config", () => {
  it("decodes the design's example config", () => {
    const config = decode(specExample);
    expect(config.source).toEqual([
      {
        id: "personal-mail",
        plugin: "gws",
        sync_every: Duration.minutes(5),
        config: { command: ["gws"], backfill: "newer_than:30d" },
      },
    ]);
    expect(config.tag.map(({ name, ai }) => [name, ai])).toEqual([
      ["work", true],
      ["promos", false],
    ]);
    expect(config.ai?.luna?.timeout).toEqual(Duration.seconds(180));
  });

  it("defaults to no sources, tags or groups", () => {
    expect(decode({})).toEqual({ source: [], tag: [], group: [] });
  });

  it("passes [source.config] through untouched for the plugin to validate", () => {
    const config = decode({
      source: [{ id: "a", plugin: "gws", sync_every: "1h", config: { anything: { goes: 1 } } }],
    });
    expect(config.source[0]?.config).toEqual({ anything: { goes: 1 } });
  });

  it.each([
    [{ ...specExample, prot: 9347 }, '["prot"]'],
    [
      { ...specExample, digest: { ...(specExample.digest as object), treshold: 1 } },
      '["digest"]["treshold"]',
    ],
    [
      withTag({ name: "x", match: { type: "exists", target: "/title", rule: {} } }),
      '["tag"][0]["match"]["rule"]',
    ],
    [
      withTag({
        name: "x",
        match: { type: "not", rule: { type: "eq", target: "/a", is: 1, regex: "x" } },
      }),
      '["tag"][0]["match"]["rule"]["regex"]',
    ],
  ])("rejects an unknown key and reports its path %#", (input, path) => {
    expect(failure(input)).toContain(`at ${path}`);
  });

  it.each([
    [
      withTag({ name: "x", match: { type: "regex", target: "/a", regex: "(" } }),
      '["tag"][0]["match"]["regex"]',
    ],
    [
      withTag({ name: "x", match: { type: "eq", target: "a", is: 1 } }),
      '["tag"][0]["match"]["target"]',
    ],
    [withTag({ name: "x", match: { type: "glob", target: "/a" } }), '["tag"][0]["match"]'],
    [
      { ...specExample, source: [{ id: "a", plugin: "gws", sync_every: "5 minutes", config: {} }] },
      '["source"][0]["sync_every"]',
    ],
    [
      { source: [0, 1].map(() => ({ id: "dup", plugin: "gws", sync_every: "5m", config: {} })) },
      '["source"][1]["id"]',
    ],
    [
      {
        ...specExample,
        tag: [0, 1].map(() => ({ name: "dup", match: { type: "and", rules: [] } })),
      },
      '["tag"][1]["name"]',
    ],
    [
      { ...specExample, digest: { ...(specExample.digest as object), ai: "missing" } },
      '["digest"]["ai"]',
    ],
  ])("rejects an invalid value and reports its path %#", (input, path) => {
    expect(failure(input)).toContain(`at ${path}`);
  });
});
