import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const demo = join(import.meta.dirname, "../../../scripts/demo.ts");

const runDemo = async (env: Record<string, string>) => {
  const proc = Bun.spawn([process.execPath, demo], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, exitCode };
};

describe("bun run demo", () => {
  it("refuses to run against ~/.weir, however the path is spelled, and never creates it", async () => {
    const home = mkdtempSync(join(tmpdir(), "weir-demo-home-"));
    const alias = join(mkdtempSync(join(tmpdir(), "weir-demo-alias-")), "home");
    symlinkSync(home, alias);
    for (const weirHome of [join(home, ".weir"), `${home}/./.weir/`, join(alias, ".weir")]) {
      const { stderr, exitCode } = await runDemo({ HOME: home, WEIR_HOME: weirHome });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("refusing to run against ~/.weir");
      expect(existsSync(join(home, ".weir"))).toBe(false);
    }
  });

  it("refuses a WEIR_HOME that already has files in it", async () => {
    const home = mkdtempSync(join(tmpdir(), "weir-demo-home-"));
    const weirHome = join(home, "used");
    mkdirSync(weirHome);
    await Bun.write(join(weirHome, "config.toml"), "port = 1\n");
    const { stderr, exitCode } = await runDemo({ HOME: home, WEIR_HOME: weirHome });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("is not empty");
    expect(existsSync(join(weirHome, "weir.db"))).toBe(false);
  });
});
