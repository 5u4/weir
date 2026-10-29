import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import recordings from "../ai-replay.json" with { type: "json" };

export const inputFence = "weir-digest-input";
export const errorFence = "weir-digest-error";

type Item = {
  seq: number;
  occurred_at: string;
  from: { name?: string | null; address?: string | null };
};
type Input = {
  conversation: { id: number; title: string };
  range: { from_seq: number; to_seq: number };
  items: Item[];
};
type Output = {
  headline: string;
  topics: { title: string; state: "open" | "resolved" | "fyi"; body: string; seqs: number[] }[];
};
export type Capture = { input: Input; attempt: number; hasError: boolean };
export type Run = { stdout: string; stderr: string; exitCode: number; delayMs: number };

const fenced = (prompt: string, fence: string): string[] =>
  [...prompt.matchAll(new RegExp(`^\`\`\`${fence}\\n([\\s\\S]*?)\\n\`\`\`$`, "gm"))].map(
    (m) => m[1] ?? "",
  );

const replay = (input: Input): Output | undefined => {
  const first = input.items[0];
  const last = input.items.at(-1);
  const hit = recordings.find(
    (r) =>
      r.conversation === input.conversation.title &&
      first !== undefined &&
      last !== undefined &&
      Date.parse(r.first_occurred_at) === Date.parse(first.occurred_at) &&
      Date.parse(r.last_occurred_at) === Date.parse(last.occurred_at),
  );
  if (hit === undefined) return undefined;
  const topics = hit.output.topics.map(({ positions, ...topic }) => ({
    ...topic,
    state: topic.state as Output["topics"][number]["state"],
    seqs: positions.map((p) => input.items[p]?.seq),
  }));
  const inRange = (t: (typeof topics)[number]): t is Output["topics"][number] =>
    t.seqs.every((s) => s !== undefined);
  return topics.every(inRange) ? { headline: hit.output.headline, topics } : undefined;
};

const envelope = (input: Input): Output => {
  const senders = [...new Set(input.items.map((i) => i.from.name ?? i.from.address ?? "?"))];
  return {
    headline: `${input.items.length} 条新消息：${input.conversation.title}`.slice(0, 40),
    topics: [
      {
        title: `第 ${input.range.from_seq}–${input.range.to_seq} 条`,
        state: "fyi",
        body: `来自 ${senders.join("、")}`.slice(0, 80),
        seqs: input.items.map((i) => i.seq),
      },
    ],
  };
};

export const runAi = (argv: string[], prompt: string): Run => {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      invalid: { type: "string" },
      delay: { type: "string" },
      exit: { type: "string" },
      capture: { type: "string" },
    },
  });
  const fail = (stderr: string, exitCode = 2): Run => ({
    stdout: "",
    stderr,
    exitCode,
    delayMs: 0,
  });
  if (values.invalid !== undefined && values.invalid !== "first" && values.invalid !== "always")
    return fail(`fake-ai: --invalid must be first or always\n`);
  const blocks = fenced(prompt, inputFence);
  if (blocks.length !== 1)
    return fail(`fake-ai: expected one ${inputFence} block, got ${blocks.length}\n`);
  const input = JSON.parse(blocks[0] ?? "") as Input;
  if (input.items.length === 0) return fail("fake-ai: the input has no items\n");
  const hasError = fenced(prompt, errorFence).length > 0;

  if (values.capture !== undefined) {
    const earlier = existsSync(values.capture)
      ? readFileSync(values.capture, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Capture)
          .filter(
            (c) =>
              c.input.conversation.id === input.conversation.id &&
              c.input.range.from_seq === input.range.from_seq &&
              c.input.range.to_seq === input.range.to_seq,
          ).length
      : 0;
    const capture: Capture = { input, attempt: earlier + 1, hasError };
    appendFileSync(values.capture, `${JSON.stringify(capture)}\n`);
  }

  const delayMs = values.delay === undefined ? 0 : Number.parseInt(values.delay, 10);
  if (values.exit !== undefined) {
    const code = Number.parseInt(values.exit, 10);
    return {
      stdout: "",
      stderr: `fake-ai: exiting with ${code} as asked\n`,
      exitCode: code,
      delayMs,
    };
  }
  const invalid = values.invalid === "always" || (values.invalid === "first" && !hasError);
  const output = invalid ? { headline: "", topics: [] } : (replay(input) ?? envelope(input));
  return {
    stdout: `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n`,
    stderr: "",
    exitCode: 0,
    delayMs,
  };
};
