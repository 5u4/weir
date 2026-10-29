#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { runGws } from "../gws.ts";
import { FIXTURE_NOW } from "../index.ts";
import { callsFile, readMailbox, seed } from "../mailbox.ts";

const result = runGws(
  process.argv.slice(2),
  (dir) => (dir === undefined ? seed(FIXTURE_NOW) : readMailbox(dir)),
  Effect.runSync(Clock.currentTimeMillis),
);
if (result.log && existsSync(result.log.mailboxDir)) {
  appendFileSync(callsFile(result.log.mailboxDir), `${JSON.stringify(result.log.call)}\n`);
}
await Bun.sleep(result.delayMs);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
