import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { decode } from "@toon-format/toon";
import * as Home from "@weir/daemon/Home";
import * as Effect from "effect/Effect";

const cliMain = join(import.meta.dirname, "../src/main.ts");

const run = (cwd: string, weirHome: string, args: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([process.execPath, cliMain, ...args], {
      cwd,
      env: { ...process.env, WEIR_HOME: weirHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, output: decode(stdout) as Record<string, unknown> };
  });

const weir = (home: Home.WeirHome, ...args: ReadonlyArray<string>) =>
  run(process.cwd(), home.root, args);

const alive = (pid: unknown) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

const makeHome = (config: (port: number) => string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const home = Home.make(mkdtempSync(join(tmpdir(), "weir-lifecycle-")));
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = Number(server.port);
      server.stop(true);
      writeFileSync(home.config, config(port));
      return { home, port };
    }),
    ({ home }) => weir(home, "stop"),
  );

describe("weir start and stop", () => {
  it.live("start leaves a daemon running after the CLI exits and stop ends it", () =>
    Effect.gen(function* () {
      const { home, port } = yield* makeHome((port) => `port = ${port}\n`);
      const started = yield* weir(home, "start");
      expect(started.exitCode).toBe(0);
      expect(started.output).toMatchObject({
        daemon: "started",
        url: `http://127.0.0.1:${port}`,
        log: home.log,
      });
      const pid = started.output.pid;
      expect(alive(pid)).toBe(true);

      const status = yield* weir(home);
      expect(status.exitCode).toBe(0);
      expect(status.output.weir).toBe(home.root);

      const again = yield* weir(home, "start");
      expect(again.exitCode).toBe(0);
      expect(again.output).toMatchObject({ daemon: "running", pid });

      const stopped = yield* weir(home, "stop");
      expect(stopped.exitCode).toBe(0);
      expect(stopped.output).toMatchObject({ daemon: "stopped", pid });
      expect(alive(pid)).toBe(false);
      expect(existsSync(home.daemon)).toBe(false);

      const stoppedAgain = yield* weir(home, "stop");
      expect(stoppedAgain.exitCode).toBe(0);
      expect(stoppedAgain.output.daemon).toBe("not running");
    }).pipe(Effect.scoped),
  );

  it.live("start fails with the config error from the daemon log", () =>
    Effect.gen(function* () {
      const { home } = yield* makeHome(() => `port = "nope"\n`);
      const { exitCode, output } = yield* weir(home, "start");
      expect(exitCode).toBe(1);
      expect(output.error).toContain("exited during startup");
      expect(output.log).toContain(`invalid config ${home.config}`);
      expect(output.help).toEqual(["weir start"]);
    }).pipe(Effect.scoped),
  );

  it.live("a daemon.json naming a dead process does not block start", () =>
    Effect.gen(function* () {
      const { home, port } = yield* makeHome((port) => `port = ${port}\n`);
      writeFileSync(
        home.daemon,
        JSON.stringify({ port, pid: 999_999, started: "Thu Jan  1 00:00:00 1970" }),
      );
      const { exitCode, output } = yield* weir(home, "start");
      expect(exitCode).toBe(0);
      expect(output.daemon).toBe("started");
      expect(alive(output.pid)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("start and stop resolve a relative WEIR_HOME against the caller's cwd", () =>
    Effect.gen(function* () {
      const { home } = yield* makeHome((port) => `port = ${port}\n`);
      const relative = (...args: ReadonlyArray<string>) =>
        run(dirname(home.root), basename(home.root), args);
      const started = yield* relative("start");
      expect(started.exitCode).toBe(0);
      expect(started.output.daemon).toBe("started");
      const pid = started.output.pid;
      expect(alive(pid)).toBe(true);

      const stopped = yield* relative("stop");
      expect(stopped.exitCode).toBe(0);
      expect(stopped.output).toMatchObject({ daemon: "stopped", pid });
      expect(alive(pid)).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("weir restart", () => {
  it.live("restart starts a stopped daemon, then replaces a running one", () =>
    Effect.gen(function* () {
      const { home, port } = yield* makeHome((port) => `port = ${port}\n`);
      const first = yield* weir(home, "restart");
      expect(first.exitCode).toBe(0);
      expect(first.output).toMatchObject({ daemon: "started", url: `http://127.0.0.1:${port}` });
      const pid = first.output.pid;
      expect(alive(pid)).toBe(true);

      const second = yield* weir(home, "restart");
      expect(second.exitCode).toBe(0);
      expect(second.output).toMatchObject({ daemon: "restarted", previous_pid: pid });
      expect(second.output.pid).not.toBe(pid);
      expect(alive(pid)).toBe(false);
      expect(alive(second.output.pid)).toBe(true);
      expect((yield* weir(home)).exitCode).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live(
    "restart recovers a daemon that is alive but not answering",
    () =>
      Effect.gen(function* () {
        const { home } = yield* makeHome((port) => `port = ${port}\n`);
        const pid = Number((yield* weir(home, "start")).output.pid);
        process.kill(pid, "SIGSTOP");

        const refused = yield* weir(home, "start");
        expect(refused.exitCode).toBe(1);
        expect(refused.output.help).toEqual(["weir restart"]);

        const restarted = yield* weir(home, "restart");
        expect(restarted.exitCode).toBe(0);
        expect(restarted.output).toMatchObject({ daemon: "restarted", previous_pid: pid });
        expect(alive(pid)).toBe(false);
        expect(alive(restarted.output.pid)).toBe(true);
      }).pipe(Effect.scoped),
    30_000,
  );
});
