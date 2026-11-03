import { fileURLToPath } from "node:url";
import { Api } from "@weir/daemon/Api";
import * as Home from "@weir/daemon/Home";
import * as ProcessIdentity from "@weir/daemon/ProcessIdentity";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const startTimeout = "20 seconds";
const stopTimeout = "10 seconds";
const poll = "50 millis";
const logTailBytes = 64 * 1024;

export type DaemonState = Data.TaggedEnum<{
  Stopped: { readonly stale: boolean };
  Running: Home.DaemonFile;
  Silent: Home.DaemonFile;
}>;
export const DaemonState = Data.taggedEnum<DaemonState>();

export class DaemonExited extends Schema.TaggedError<DaemonExited>()("DaemonExited", {
  code: Schema.NullOr(Schema.Int),
  log: Schema.Array(Schema.String),
}) {
  override get message() {
    return `weir daemon exited during startup with code ${this.code ?? "unknown"}`;
  }
}

export class DaemonSilent extends Schema.TaggedError<DaemonSilent>()("DaemonSilent", {
  pid: Schema.Int,
  log: Schema.Array(Schema.String),
}) {
  override get message() {
    return `weir daemon pid ${this.pid} is alive but not answering; run weir stop`;
  }
}

export const url = (port: number) => `http://127.0.0.1:${port}`;

const readDaemonFile = (home: Home.WeirHome) =>
  FileSystem.FileSystem.use((fs) => fs.readFileString(home.daemon)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Home.DaemonFile))),
    Effect.option,
  );

export const derive = (home: Home.WeirHome) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(home.daemon))) {
      return DaemonState.Stopped({ stale: false });
    }
    const file = yield* readDaemonFile(home);
    if (Option.isNone(file) || !(yield* ProcessIdentity.isAlive(file.value))) {
      return DaemonState.Stopped({ stale: true });
    }
    const status = yield* HttpApiClient.make(Api, { baseUrl: url(file.value.port) }).pipe(
      Effect.flatMap((client) => client.status()),
      Effect.timeout("1 second"),
      Effect.option,
    );
    return Option.isSome(status) ? DaemonState.Running(file.value) : DaemonState.Silent(file.value);
  });

const logSince = (home: Home.WeirHome, offset: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = Number((yield* fs.stat(home.log)).size);
    const from = Math.max(offset, size - logTailBytes);
    const text = yield* fs
      .stream(home.log, { offset: from, bytesToRead: size - from })
      .pipe(Stream.decodeText(), Stream.mkString);
    return text
      .split("\n")
      .slice(from > offset ? 1 : 0)
      .map((line) => line.trim().replace(/\s*\{$/, ""))
      .filter((line) => line.length > 0 && line !== "}" && !line.startsWith("at "))
      .slice(-20);
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

export const start = (home: Home.WeirHome) =>
  Effect.gen(function* () {
    const state = yield* derive(home);
    if (state._tag === "Running") {
      return { daemon: state, started: false };
    }
    if (state._tag === "Silent") {
      return yield* new DaemonSilent({ pid: state.pid, log: yield* logSince(home, 0) });
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(home.root, { recursive: true });
    const offset = yield* fs.stat(home.log).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(0)),
    );
    // Effect's File hides its descriptor and Bun truncates a BunFile used as stdio, so sh appends.
    const child = Bun.spawn({
      cmd: [
        "/bin/sh",
        "-c",
        'log=$1; shift; exec "$@" >>"$log" 2>&1',
        "weir-daemon",
        home.log,
        process.execPath,
        fileURLToPath(import.meta.resolve("@weir/daemon/main")),
      ],
      cwd: home.root,
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    child.unref();
    return yield* Effect.gen(function* () {
      for (;;) {
        const current = yield* derive(home);
        if (current._tag === "Running" && current.pid === child.pid) {
          return { daemon: current, started: true };
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          return yield* new DaemonExited({
            code: child.exitCode,
            log: yield* logSince(home, offset),
          });
        }
        yield* Effect.sleep(poll);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: startTimeout,
        orElse: () =>
          Effect.flatMap(
            logSince(home, offset),
            (log) => new DaemonSilent({ pid: child.pid, log }),
          ),
      }),
    );
  });

const signal = (target: ProcessIdentity.ProcessIdentity, name: "SIGTERM" | "SIGKILL") =>
  Effect.try(() => process.kill(target.pid, name)).pipe(
    Effect.ignore,
    Effect.when(ProcessIdentity.isAlive(target)),
  );

const awaitExit = (target: ProcessIdentity.ProcessIdentity) =>
  Effect.gen(function* () {
    while (yield* ProcessIdentity.isAlive(target)) {
      yield* Effect.sleep(poll);
    }
  });

export const stop = (home: Home.WeirHome) =>
  Effect.gen(function* () {
    const state = yield* derive(home);
    const target =
      state._tag === "Stopped"
        ? Option.none<ProcessIdentity.ProcessIdentity>()
        : Option.some<ProcessIdentity.ProcessIdentity>({ pid: state.pid, started: state.started });
    if (Option.isSome(target)) {
      yield* signal(target.value, "SIGTERM");
      yield* awaitExit(target.value).pipe(
        Effect.timeoutOrElse({
          duration: stopTimeout,
          orElse: () =>
            signal(target.value, "SIGKILL").pipe(Effect.andThen(awaitExit(target.value))),
        }),
      );
    }
    const left = yield* readDaemonFile(home);
    if (Option.isSome(left) && !(yield* ProcessIdentity.isAlive(left.value))) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(home.daemon).pipe(Effect.ignore);
    }
    return target;
  });
