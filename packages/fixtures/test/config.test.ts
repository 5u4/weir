import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configToml } from "@weir/fixtures";
import { expect, it } from "vitest";

it("keeps the committed config.toml identical to configToml()", () => {
  expect(readFileSync(join(import.meta.dirname, "../config.toml"), "utf8")).toBe(configToml());
});
