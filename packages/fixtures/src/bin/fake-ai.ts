#!/usr/bin/env bun
import { runAi } from "../ai.ts";

const result = runAi(process.argv.slice(2), await Bun.stdin.text());
if (result.delayMs > 0) await Bun.sleep(result.delayMs);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
