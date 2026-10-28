#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { plugins } from "./Daemon.ts";
import * as Home from "./Home.ts";
import * as Http from "./Http.ts";

Effect.gen(function* () {
  const home = yield* Home.fromEnv;
  return yield* Layer.launch(Http.layer(home, plugins));
}).pipe(
  Effect.catchTag("ConfigInvalid", (error) =>
    Console.error(error.message).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
  BunRuntime.runMain,
);
