import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("vite build reads no daemon home, so it builds with HOME, WEIR_HOME and WEIR_PORT unset", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "weir-web-build-"));
  const { HOME: _home, WEIR_HOME: _weirHome, WEIR_PORT: _weirPort, ...env } = process.env;
  const proc = Bun.spawn(
    [process.execPath, "--bun", "vite", "build", "--outDir", outDir, "--emptyOutDir"],
    { cwd: join(import.meta.dirname, ".."), env, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  expect(stderr).not.toMatch(/HOME/);
  expect(code).toBe(0);
  expect(readFileSync(join(outDir, "index.html"), "utf8")).toMatch(/<div id="root">/);
});
