import * as Build from "@weir/daemon/Build";
import type * as Home from "@weir/daemon/Home";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Lifecycle from "./Lifecycle.ts";

export const defaultBase = "https://github.com/5u4/weir";

const installTailLines = 20;

export class DevBuild extends Schema.TaggedError<DevBuild>()("DevBuild", {
  message: Schema.String,
}) {}

export class ReleaseNotFound extends Schema.TaggedError<ReleaseNotFound>()("ReleaseNotFound", {
  message: Schema.String,
}) {}

export class ReleaseUnreachable extends Schema.TaggedError<ReleaseUnreachable>()(
  "ReleaseUnreachable",
  { message: Schema.String },
) {}

export class InstallFailed extends Schema.TaggedError<InstallFailed>()("InstallFailed", {
  message: Schema.String,
  output: Schema.Array(Schema.String),
}) {}

type Version = readonly [number, number, number];

const parseVersion = (text: string): Option.Option<Version> => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match === null
    ? Option.none()
    : Option.some([Number(match[1]), Number(match[2]), Number(match[3])]);
};

export const isNewer = (candidate: string, installed: string): boolean =>
  Option.match(Option.all([parseVersion(candidate), parseVersion(installed)]), {
    onNone: () => false,
    onSome: ([[aMajor, aMinor, aPatch], [bMajor, bMinor, bPatch]]) =>
      aMajor !== bMajor ? aMajor > bMajor : aMinor !== bMinor ? aMinor > bMinor : aPatch > bPatch,
  });

export const parseLocation = (location: string, requested: string): Option.Option<string> => {
  const path = URL.parse(location, requested)?.pathname ?? "";
  const match = /\/releases\/tag\/v(?<version>\d+\.\d+\.\d+)$/.exec(path);
  return Option.fromNullishOr(match?.groups?.version);
};

export const latest = (base: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${base}/releases/latest`).pipe(
      Effect.mapError(
        (error) =>
          new ReleaseUnreachable({
            message: `cannot reach ${base}/releases/latest: ${error.message}`,
          }),
      ),
    );
    const location = response.headers.location ?? "";
    return yield* Option.match(parseLocation(location, `${base}/releases/latest`), {
      onNone: () =>
        Effect.fail(
          new ReleaseNotFound({
            message: `no release found at ${base}/releases/latest (status ${response.status}, location ${location || "none"})`,
          }),
        ),
      onSome: Effect.succeed,
    });
  }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));

export const check = (installed: string, base: string) =>
  Effect.map(latest(base), (version) => ({
    installed,
    latest: version,
    current: !isNewer(version, installed),
  }));

const install = (url: string) =>
  Effect.gen(function* () {
    const { exitCode, output } = yield* Effect.promise(async () => {
      const proc = Bun.spawn([process.execPath, "add", "-g", url], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, output: `${stdout}\n${stderr}` };
    });
    if (exitCode !== 0) {
      return yield* new InstallFailed({
        message: `bun add -g ${url} exited with ${exitCode}`,
        output: output
          .split("\n")
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0)
          .slice(-installTailLines),
      });
    }
  });

export const run = (home: Home.WeirHome, base: string) =>
  Effect.gen(function* () {
    if (Option.isNone(parseVersion(Build.version))) {
      return yield* new DevBuild({
        message: `weir ${Build.version} runs from source; upgrade it with git pull instead`,
      });
    }
    const release = yield* check(Build.version, base);
    if (release.current) {
      return { _tag: "Current" as const, version: Build.version };
    }
    yield* install(`${base}/releases/download/v${release.latest}/weir.tgz`);
    const state = yield* Lifecycle.derive(home);
    const daemon =
      state._tag === "Stopped"
        ? Option.none()
        : Option.some((yield* Lifecycle.restart(home)).daemon);
    return { _tag: "Upgraded" as const, from: Build.version, to: release.latest, daemon };
  });
