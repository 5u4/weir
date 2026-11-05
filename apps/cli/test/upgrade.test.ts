import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as Upgrade from "../src/Upgrade.ts";

describe("version order", () => {
  it.each([
    ["0.10.0", "0.9.0", true],
    ["0.2.0", "0.2.0", false],
    ["0.1.0", "0.2.0", false],
    ["1.0.0", "0.99.99", true],
    ["0.2.1", "0.2.0", true],
  ])("%s newer than %s is %s", (candidate, installed, expected) => {
    expect(Upgrade.isNewer(candidate, installed)).toBe(expected);
  });
});

describe("latest release location", () => {
  const requested = "https://github.com/5u4/weir/releases/latest";
  it.each([
    ["https://github.com/5u4/weir/releases/tag/v0.3.0", Option.some("0.3.0")],
    ["/5u4/weir/releases/tag/v1.12.4", Option.some("1.12.4")],
    ["tag/v0.3.0", Option.some("0.3.0")],
    ["/5u4/weir/releases", Option.none()],
    ["/5u4/weir/releases/tag/nightly", Option.none()],
    ["::not a url", Option.none()],
    ["", Option.none()],
  ])("%s", (location, expected) => {
    expect(Upgrade.parseLocation(location, requested)).toEqual(expected);
  });
});

const fakeReleases = (location: string | null) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
          new URL(request.url).pathname === "/5u4/weir/releases/latest"
            ? new Response(null, {
                status: 302,
                headers: location === null ? {} : { location },
              })
            : new Response("not found", { status: 404 }),
      }),
    ),
    (server) => Effect.sync(() => server.stop(true)),
  ).pipe(Effect.map((server) => `http://127.0.0.1:${server.port}/5u4/weir`));

const check = (installed: string, base: string) =>
  Upgrade.check(installed, base).pipe(Effect.provide(FetchHttpClient.layer), Effect.exit);

describe("release check", () => {
  it.live("a newer tag is not current", () =>
    Effect.gen(function* () {
      const base = yield* fakeReleases("https://github.com/5u4/weir/releases/tag/v0.2.0");
      expect(yield* check("0.1.0", base)).toEqual(
        Exit.succeed({ installed: "0.1.0", latest: "0.2.0", current: false }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("the same tag is current", () =>
    Effect.gen(function* () {
      const base = yield* fakeReleases("/5u4/weir/releases/tag/v0.2.0");
      expect(yield* check("0.2.0", base)).toEqual(
        Exit.succeed({ installed: "0.2.0", latest: "0.2.0", current: true }),
      );
    }).pipe(Effect.scoped),
  );

  it.live("a repo with no release fails as ReleaseNotFound", () =>
    Effect.gen(function* () {
      const base = yield* fakeReleases("/5u4/weir/releases");
      const exit = yield* check("0.1.0", base);
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("ReleaseNotFound");
    }).pipe(Effect.scoped),
  );

  it.live("an unreachable server fails as ReleaseUnreachable", () =>
    Effect.gen(function* () {
      const base = yield* fakeReleases(null);
      const dead = base.replace(/:\d+/, ":1");
      const exit = yield* check("0.1.0", dead);
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("ReleaseUnreachable");
    }).pipe(Effect.scoped),
  );
});

describe("weir upgrade from source", () => {
  it.live("refuses a dev build", () =>
    Effect.promise(async () => {
      const proc = Bun.spawn(
        [process.execPath, join(import.meta.dirname, "../src/main.ts"), "upgrade"],
        { env: { ...process.env, WEIR_RELEASES: "http://127.0.0.1:1" }, stdout: "pipe" },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain("runs from source");
    }),
  );
});
