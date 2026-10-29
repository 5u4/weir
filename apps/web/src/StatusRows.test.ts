import type { Status } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";
import { digestRows, waitingLine } from "./StatusRows.ts";

type Digest = NonNullable<Status["digest"]>;

const digest = (overrides: Partial<Digest> = {}): Digest => ({
  ai: "luna",
  threshold: 1000,
  running: [],
  queued: [],
  last_run: null,
  ...overrides,
});

const job = (conversation_id: number, from_seq = 1) => ({
  conversation_id,
  from_seq,
  to_seq: from_seq + 1,
  trigger: "auto" as const,
  title: `Conversation ${conversation_id}`,
});

const idle = { label: "Queue", jobs: [] };

const at = "2026-10-25T16:00:00.000Z";

describe("digestRows", () => {
  it.each<[string, Status["digest"], ReadonlyArray<unknown>]>([
    ["no [digest] has no rows", null, []],
    [
      "no run in 24 hours hides Last run; an idle queue is empty",
      digest(),
      [
        idle,
        { label: "Threshold", text: "1,000 characters of new text" },
        { label: "AI profile", profile: "luna" },
      ],
    ],
    [
      "the queue lists running then queued jobs by title, in order",
      digest({ running: [job(7, 40)], queued: [job(3), job(7, 50)] }),
      [
        {
          label: "Queue",
          jobs: [
            { key: "running:7:40", title: "Conversation 7", state: "running" },
            { key: "queued:3:1", title: "Conversation 3", state: "queued" },
            { key: "queued:7:50", title: "Conversation 7", state: "queued" },
          ],
        },
        { label: "Threshold", text: "1,000 characters of new text" },
        { label: "AI profile", profile: "luna" },
      ],
    ],
    [
      "a run sums written, failed and the average",
      digest({
        threshold: 2500,
        ai: "fake-ai",
        last_run: { at, written: 3, failed: 1, avg_ms: 1501 },
      }),
      [
        idle,
        {
          label: "Last run",
          at: DateTime.makeUnsafe(at),
          detail: "3 digests, 1 failed, 1.5s each on average",
        },
        { label: "Threshold", text: "2,500 characters of new text" },
        { label: "AI profile", profile: "fake-ai" },
      ],
    ],
    [
      "only failures omit the average",
      digest({ last_run: { at, written: 0, failed: 2, avg_ms: null } }),
      [
        idle,
        { label: "Last run", at: DateTime.makeUnsafe(at), detail: "0 digests, 2 failed" },
        { label: "Threshold", text: "1,000 characters of new text" },
        { label: "AI profile", profile: "luna" },
      ],
    ],
    [
      "one digest is singular",
      digest({ last_run: { at, written: 1, failed: 0, avg_ms: 12000 } }),
      [
        idle,
        {
          label: "Last run",
          at: DateTime.makeUnsafe(at),
          detail: "1 digest, 0 failed, 12.0s each on average",
        },
        { label: "Threshold", text: "1,000 characters of new text" },
        { label: "AI profile", profile: "luna" },
      ],
    ],
  ])("%s", (_, value, rows) => {
    expect(digestRows(value)).toEqual(rows);
  });
});

describe("waitingLine", () => {
  it.each<[string, Status["digest"], boolean, string | null]>([
    ["no [digest] has no line", null, false, null],
    ["nothing queued is caught up", digest(), false, "Caught up"],
    ["a stopped config stops digests", digest({ queued: [job(1)] }), true, "Stopped"],
    [
      "counts conversations, not jobs",
      digest({ running: [job(1)], queued: [job(1), job(2), job(3)] }),
      false,
      "3 conversations waiting",
    ],
    ["one conversation is singular", digest({ queued: [job(4)] }), false, "1 conversation waiting"],
  ])("%s", (_, value, stopped, line) => {
    expect(waitingLine(value, stopped)).toBe(line);
  });
});
