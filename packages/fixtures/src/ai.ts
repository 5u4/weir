import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import recordings from "../ai-replay.json" with { type: "json" };

export const inputFence = "weir-digest-input";
export const errorFence = "weir-digest-error";

type Item = {
  seq: number;
  occurred_at: string;
  from: { name?: string | null; address?: string | null };
  body_new: string;
};
type Input = {
  conversation: { id: number; title: string };
  range: { from_seq: number; to_seq: number };
  context: ({ kind: "digest"; topics: Topic[] } | { kind: "item" })[];
  items: Item[];
};
type Topic = {
  title: string;
  state: "open" | "resolved" | "fyi";
  body: string;
  seqs: number[];
  due?: { date: string; seq: number };
};
type Output = { headline: string; topics: Topic[] };
type RecordedTopic = {
  title: string;
  state: string;
  body: string;
  positions: number[];
  due?: { date: string; position: number };
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
  const topics = hit.output.topics.map(
    ({ positions, due, ...topic }: RecordedTopic): Topic | undefined => {
      const seqs = positions.map((position) => input.items[position]?.seq);
      const dueSeq = due === undefined ? undefined : input.items[due.position]?.seq;
      if (!seqs.every((seq) => seq !== undefined)) return undefined;
      if (due !== undefined && dueSeq === undefined) return undefined;
      return {
        ...topic,
        state: topic.state as Topic["state"],
        seqs,
        ...(due === undefined || dueSeq === undefined
          ? {}
          : { due: { date: due.date, seq: dueSeq } }),
      };
    },
  );
  return topics.every((topic) => topic !== undefined)
    ? { headline: hit.output.headline, topics }
    : undefined;
};

const dueState = (input: Input): Pick<Topic, "state" | "due"> => {
  for (const item of input.items.toReversed()) {
    if (/\bdone\b/.test(item.body_new)) return { state: "resolved" };
    const date = item.body_new.match(/\bdue (\d{4}-\d{2}-\d{2})\b/)?.[1];
    if (date !== undefined) return { state: "open", due: { date, seq: item.seq } };
  }
  const carried = input.context
    .flatMap((entry) => (entry.kind === "digest" ? entry.topics : []))
    .flatMap(({ due }) => (due === undefined ? [] : [due]))
    .at(-1);
  return carried === undefined ? { state: "fyi" } : { state: "open", due: carried };
};

const envelope = (input: Input, dues: boolean): Output => {
  const senders = [...new Set(input.items.map((i) => i.from.name ?? i.from.address ?? "?"))];
  return {
    headline: `${input.items.length} 条新消息：${input.conversation.title}`.slice(0, 40),
    topics: [
      {
        title: `第 ${input.range.from_seq}–${input.range.to_seq} 条`,
        body: `来自 ${senders.join("、")}`.slice(0, 80),
        seqs: input.items.map((i) => i.seq),
        ...(dues ? dueState(input) : { state: "fyi" }),
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
      dues: { type: "boolean", default: false },
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
  const output = invalid
    ? { headline: "", topics: [] }
    : (replay(input) ?? envelope(input, values.dues));
  return {
    stdout: `\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n`,
    stderr: "",
    exitCode: 0,
    delayMs,
  };
};
