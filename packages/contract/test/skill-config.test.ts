import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { decodeConfig } from "../src/Config.ts";

const skill = await Bun.file(
  new URL("../../../skills/weir-config/SKILL.md", import.meta.url),
).text();
const blocks = [...skill.matchAll(/```toml\n([\s\S]*?)```/g)].map(([, toml]) => toml ?? "");

it("decodes every toml example in the weir-config skill", () => {
  expect(blocks.length).toBeGreaterThan(0);
  for (const toml of blocks) {
    expect(() => Effect.runSync(decodeConfig(Bun.TOML.parse(toml)))).not.toThrow();
  }
});
