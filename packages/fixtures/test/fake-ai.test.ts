import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DigestInput,
  DigestOutput,
  digestErrorFence,
  digestInputFence,
  type InputItem,
} from "@weir/contract/Digest";
import * as Schema from "effect/Schema";
import { afterEach, expect, it } from "vitest";
import replay from "../ai-replay.json" with { type: "json" };

const FAKE_AI = join(import.meta.dirname, "../../../node_modules/.bin/fake-ai");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const item = (seq: number, occurred_at: string, name: string): InputItem => ({
  seq,
  occurred_at,
  from: { name, address: `${name.toLowerCase()}@example.com` },
  from_me: false,
  title: null,
  body_new: `message ${seq}`,
});

const input = (title: string, items: InputItem[]): DigestInput => ({
  language: "zh-CN",
  guide: null,
  conversation: { id: 7, source: "gmail", title },
  range: { from_seq: items[0]?.seq ?? 0, to_seq: items.at(-1)?.seq ?? 0 },
  context: [],
  items,
});

const northwind = input("Northwind migration: cutover plan and UAT sign-off", [
  item(21, "2026-10-20T11:05:00-07:00", "Rachel"),
  item(22, "2026-10-21T09:00:00-07:00", "Lisa"),
  item(23, "2026-10-22T09:00:00-07:00", "Ben"),
  item(24, "2026-10-23T08:05:00-07:00", "Rachel"),
]);
const unrecorded = input("Quarterly offsite: rooms and agenda for the whole team in November", [
  item(3, "2026-10-22T10:00:00Z", "Ana"),
  item(5, "2026-10-22T11:00:00Z", "Bo"),
]);

const prompt = (digest: DigestInput, error?: string) =>
  [
    "Summarise the range.",
    `\`\`\`${digestInputFence}\n${JSON.stringify(digest)}\n\`\`\``,
    ...(error === undefined ? [] : [`\`\`\`${digestErrorFence}\n${error}\n\`\`\``]),
  ].join("\n\n");

const run = (args: string[], stdin: string) => {
  const proc = Bun.spawnSync([FAKE_AI, ...args], { stdin: Buffer.from(stdin) });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
};

const lastJson = (stdout: string): unknown => {
  const blocks = [...stdout.matchAll(/```json\n([\s\S]*?)\n```/g)];
  return JSON.parse(blocks.at(-1)?.[1] ?? "null");
};
const decodes = (stdout: string) =>
  Schema.decodeUnknownExit(DigestOutput)(lastJson(stdout))._tag === "Success";

it("replays the recording keyed by title and first/last occurred_at, mapping positions to the input's seqs", () => {
  const out = run([], prompt(northwind));
  expect(out.exitCode).toBe(0);
  const recorded = replay[0]?.output;
  expect(lastJson(out.stdout)).toEqual({
    headline: recorded?.headline,
    topics: [
      {
        title: recorded?.topics[0]?.title,
        state: "open",
        body: recorded?.topics[0]?.body,
        seqs: [21, 22, 23, 24],
      },
    ],
  });
  expect(decodes(out.stdout)).toBe(true);
});

it("answers an unrecorded range deterministically within the contract and the range rules", () => {
  const first = run([], prompt(unrecorded));
  expect(first.exitCode).toBe(0);
  expect(decodes(first.stdout)).toBe(true);
  const output = lastJson(first.stdout) as DigestOutput;
  expect(output.topics).toHaveLength(1);
  expect(output.topics[0]?.seqs).toEqual([3, 5]);
  expect(run([], prompt(unrecorded)).stdout).toBe(first.stdout);

  const single = input("Solo", [item(9, "2026-10-22T10:00:00Z", "Ana")]);
  const one = lastJson(run([], prompt(single)).stdout) as DigestOutput;
  expect(one.topics.map((t) => t.seqs)).toEqual([[9]]);
});

it("--invalid first fails the first attempt and answers the retry; --invalid always never answers", () => {
  expect(decodes(run(["--invalid", "first"], prompt(northwind)).stdout)).toBe(false);
  expect(decodes(run(["--invalid", "first"], prompt(northwind, "headline: empty")).stdout)).toBe(
    true,
  );
  expect(decodes(run(["--invalid", "always"], prompt(northwind)).stdout)).toBe(false);
  expect(decodes(run(["--invalid", "always"], prompt(northwind, "headline: empty")).stdout)).toBe(
    false,
  );
});

it("--exit exits with that code and one stderr line", () => {
  const out = run(["--exit", "3"], prompt(northwind));
  expect(out.exitCode).toBe(3);
  expect(out.stdout).toBe("");
  expect(out.stderr.trimEnd().split("\n")).toHaveLength(1);
});

it("--capture appends one JSONL line per call with the input, attempt and error-block presence", () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-ai-"));
  dirs.push(dir);
  const file = join(dir, "calls.jsonl");
  run(["--capture", file, "--invalid", "first"], prompt(northwind));
  run(["--capture", file, "--invalid", "first"], prompt(northwind, "headline: empty"));
  run(["--capture", file], prompt(unrecorded));
  const lines = readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { input: northwind, attempt: 1, hasError: false },
    { input: northwind, attempt: 2, hasError: true },
    { input: unrecorded, attempt: 1, hasError: false },
  ]);
});

it("--delay holds the answer for at least that long", () => {
  const started = performance.now();
  const out = run(["--delay", "300"], prompt(northwind));
  expect(performance.now() - started).toBeGreaterThanOrEqual(300);
  expect(decodes(out.stdout)).toBe(true);
});

it("exits 2 when the prompt has no input block", () => {
  const out = run([], "no fenced input here");
  expect(out.exitCode).toBe(2);
  expect(out.stderr).toMatch(/weir-digest-input/);
});
