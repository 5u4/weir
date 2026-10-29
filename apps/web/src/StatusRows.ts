import type { Status } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import { plural } from "./Health.ts";

export type QueuedJob = {
  readonly key: string;
  readonly title: string;
  readonly state: "running" | "queued";
};

export type DigestRow =
  | { readonly label: "Queue"; readonly jobs: ReadonlyArray<QueuedJob> }
  | { readonly label: "Last run"; readonly at: DateTime.Utc; readonly detail: string }
  | { readonly label: "Threshold"; readonly text: string }
  | { readonly label: "AI profile"; readonly profile: string };

// The Digests rows past AI on; a daemon without [digest] has none of them.
export const digestRows = (digest: Status["digest"]): ReadonlyArray<DigestRow> => {
  if (digest === null) return [];
  const rows: Array<DigestRow> = [
    {
      label: "Queue",
      jobs: [
        ...digest.running.map((job) => ({ job, state: "running" as const })),
        ...digest.queued.map((job) => ({ job, state: "queued" as const })),
      ].map(({ job, state }) => ({
        key: `${state}:${job.conversation_id}:${job.from_seq}`,
        title: job.title,
        state,
      })),
    },
  ];
  const run = digest.last_run;
  if (run !== null) {
    rows.push({
      label: "Last run",
      at: DateTime.makeUnsafe(run.at),
      detail: [
        plural(run.written, "digest"),
        `${run.failed.toLocaleString("en")} failed`,
        ...(run.avg_ms === null ? [] : [`${(run.avg_ms / 1000).toFixed(1)}s each on average`]),
      ].join(", "),
    });
  }
  rows.push(
    { label: "Threshold", text: `${digest.threshold.toLocaleString("en")} characters of new text` },
    { label: "AI profile", profile: digest.ai },
  );
  return rows;
};

// The empty reader's Digests line: conversations with a running or queued digest.
export const waitingLine = (digest: Status["digest"], stopped: boolean): string | null => {
  if (digest === null) return null;
  if (stopped) return "Stopped";
  const waiting = new Set(
    [...digest.running, ...digest.queued].map(({ conversation_id }) => conversation_id),
  ).size;
  return waiting === 0 ? "Caught up" : `${plural(waiting, "conversation")} waiting`;
};
