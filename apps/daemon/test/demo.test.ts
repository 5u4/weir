import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const demo = join(import.meta.dirname, "../../../scripts/demo.ts");

describe("bun run demo", () => {
  it("runs in its own temporary home and leaves WEIR_HOME and ~/.weir untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "weir-demo-home-"));
    const weirHome = mkdtempSync(join(tmpdir(), "weir-demo-weir-home-"));
    const proc = Bun.spawn([process.execPath, demo], {
      env: { ...process.env, HOME: home, WEIR_HOME: weirHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, stderr).toBe(0);
    expect(readdirSync(weirHome)).toEqual([]);
    expect(existsSync(join(home, ".weir"))).toBe(false);
  }, 60_000);
});
