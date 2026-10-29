#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type DigestInput, digestErrorFence, digestInputFence } from "@weir/contract/Digest";
import type { Capture } from "./harness.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  strict: true,
  options: {
    invalid: { type: "string" },
    delay: { type: "string" },
    exit: { type: "string" },
    capture: { type: "string" },
  },
});

const prompt = await Bun.stdin.text();
const fenced = (fence: string) =>
  [...prompt.matchAll(new RegExp(`^\`\`\`${fence}\\n([\\s\\S]*?)\\n\`\`\`$`, "gm"))].map(
    (match) => match[1] ?? "",
  );

const blocks = fenced(digestInputFence);
if (blocks.length !== 1) {
  process.stderr.write(`fake-ai: expected one ${digestInputFence} block, got ${blocks.length}\n`);
  process.exit(2);
}
const input = JSON.parse(blocks[0] ?? "") as DigestInput;
const hasError = fenced(digestErrorFence).length > 0;

if (values.capture !== undefined) {
  const earlier = existsSync(values.capture)
    ? readFileSync(values.capture, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Capture)
        .filter(
          ({ input: { conversation, range } }) =>
            conversation.id === input.conversation.id &&
            range.from_seq === input.range.from_seq &&
            range.to_seq === input.range.to_seq,
        ).length
    : 0;
  appendFileSync(
    values.capture,
    `${JSON.stringify({ input, attempt: earlier + 1, hasError } satisfies Capture)}\n`,
  );
}

if (values.delay !== undefined) await Bun.sleep(Number.parseInt(values.delay, 10));

if (values.exit !== undefined) {
  process.stderr.write(`fake-ai: exiting with ${values.exit} as asked\n`);
  process.exit(Number.parseInt(values.exit, 10));
}

const invalid = values.invalid === "always" || (values.invalid === "first" && !hasError);
const senders = [...new Set(input.items.map(({ from }) => from.name || from.address))];
const output = invalid
  ? { headline: "", topics: [] }
  : {
      headline: `${input.items.length} 条新消息：${input.conversation.title}`.slice(0, 40),
      topics: [
        {
          title: `第 ${input.range.from_seq}–${input.range.to_seq} 条`,
          state: "fyi",
          body: `来自 ${senders.join("、")}`.slice(0, 80),
          seqs: input.items.map(({ seq }) => seq),
        },
      ],
    };
process.stdout.write(`\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n`);
