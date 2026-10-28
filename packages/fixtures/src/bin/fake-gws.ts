#!/usr/bin/env bun
import { runGws } from "../gws.ts";
import { FIXTURE_NOW } from "../index.ts";
import { readMailbox, seed } from "../mailbox.ts";

const result = runGws(process.argv.slice(2), (dir) =>
  dir === undefined ? seed(FIXTURE_NOW) : readMailbox(dir),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
