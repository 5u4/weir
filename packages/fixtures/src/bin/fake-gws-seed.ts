#!/usr/bin/env bun
import { seedMailbox } from "../index.ts";

const [dir, flag, until, ...rest] = process.argv.slice(2);
if (
  dir === undefined ||
  dir.startsWith("-") ||
  (flag !== undefined && (flag !== "--until" || until === undefined)) ||
  rest.length
) {
  process.stderr.write("usage: fake-gws-seed <dir> [--until <iso>]\n");
  process.exit(2);
}
const summary = seedMailbox(dir, until === undefined ? {} : { until });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
