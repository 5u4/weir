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

  it("--serve keeps the daemon answering until SIGINT, then exits 130 and removes its home", async () => {
    const proc = Bun.spawn([process.execPath, demo, "--serve"], {
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "weir-demo-home-")) },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const stderr = new Response(proc.stderr).text();
      const decoder = new TextDecoder();
      let stdout = "";
      let url: string | undefined;
      for await (const chunk of proc.stdout) {
        stdout += decoder.decode(chunk, { stream: true });
        url = stdout.match(/serving (http:\/\/\S+) until Ctrl-C/)?.[1];
        if (url) break;
      }
      expect(url, stdout).toBeDefined();
      const res = await fetch(new URL("status", url));
      expect(res.status).toBe(200);

      proc.kill("SIGINT");
      const exitCode = await proc.exited;
      const log = await stderr;
      expect(exitCode, log).toBe(130);
      const root = log.match(/WEIR_HOME=(\S+)/)?.[1];
      expect(root, log).toBeDefined();
      expect(existsSync(root as string)).toBe(false);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill("SIGINT");
        await proc.exited;
      }
    }
  }, 60_000);
});
