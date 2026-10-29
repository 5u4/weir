#!/usr/bin/env bun
import { join } from "node:path";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { gws } from "@weir/plugin-gws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Home from "../src/Home.ts";
import * as Http from "../src/Http.ts";
import { filePlugin } from "./harness.ts";

Effect.gen(function* () {
  const home = yield* Home.fromEnv;
  return yield* Layer.launch(
    Http.layer(home, { fake: filePlugin(join(home.root, "source.json")), gws }),
  );
}).pipe(BunRuntime.runMain);
