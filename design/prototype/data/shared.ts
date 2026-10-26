// Contract types mirror weir-proto/CONTRACT.md.
import { tmpdir } from "node:os";

export type Addr = { name: string; addr: string };
export type Item = {
  id: string;
  source: "gmail" | "teams";
  sourceLabel: string;
  threadId: string | null;
  containerId: string;
  from: Addr;
  to: Addr[];
  cc: Addr[];
  subject: string;
  occurredAt: string;
  bodyNew: string;
  bodyQuoted: string;
  link: string;
  gist?: string;
  synthetic?: true;
};
export type PointKind = "ask" | "decision" | "date" | "info";
export type Point = { kind: PointKind; text: string; itemId: string };
export type Conversation = {
  id: string;
  title: string;
  bucket: string | null;
  summary: string;
  update: string | null;
  itemIds: string[];
  threadIds: string[];
  mergeReason: string | null;
  firstAt: string;
  lastAt: string;
  points?: Point[];
};
export type EnrichRun = {
  stage: "group" | "summarize" | "incremental" | "digest";
  batch: number;
  conversations: number;
  items: number;
  inputChars: number;
  outputChars: number;
  ms: number;
  ok: boolean;
  error?: string;
};
export type Data = {
  generatedAt: string;
  me: string[];
  seenCutoff: string;
  buckets: { id: string; name: string }[];
  items: Item[];
  conversations: Conversation[];
  enrichRuns: EnrichRun[];
};

export async function pool<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++;
        out[i] = await fn(xs[i], i);
      }
    }),
  );
  return out;
}

export function lastJson(s: string): unknown {
  for (const m of [...s.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].reverse()) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  const end = s.lastIndexOf("}");
  for (let i = s.lastIndexOf("{", end); i >= 0; i = s.lastIndexOf("{", i - 1)) {
    try {
      return JSON.parse(s.slice(i, end + 1));
    } catch {}
  }
  throw new Error("no JSON block in output");
}

export function chunk<T>(xs: T[], max: number): T[][] {
  // Even sizes so the last batch is not a tiny leftover.
  const n = Math.ceil(xs.length / max);
  const size = Math.ceil(xs.length / n);
  return Array.from({ length: n }, (_, k) => xs.slice(k * size, (k + 1) * size));
}

// The agent CLI picks its own default model; one tiny JSON-mode call lets timing.md name what actually ran.
export async function probeModel(cmd: string[]): Promise<string> {
  if (cmd[0] !== "omp") return "unknown (custom WEIR_ENRICH_CMD)";
  const proc = Bun.spawn([...cmd, "--mode", "json"], { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.stdin.write("Reply with the single word ok.");
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  const model = out.match(/"model":"([^"]+)"/)?.[1];
  return model ? `${out.match(/"provider":"([^"]+)"/)?.[1]}/${model}` : "unknown (probe failed)";
}

export type CardOut = { id: string; title: string; bucket: string; summary: string; update: string | null };
export function parseCards(out: unknown, ids: Set<string>, buckets: Record<string, unknown>): CardOut[] {
  const { conversations: list } = (typeof out === "object" && out !== null ? out : {}) as { conversations?: unknown };
  if (!Array.isArray(list)) throw new Error("expected {conversations: []}");
  const cards = list.map((c: unknown) => {
    const { id, title, bucket, summary, update } = (typeof c === "object" && c !== null ? c : {}) as Partial<Record<keyof CardOut, unknown>>;
    if (typeof id !== "string" || !ids.has(id)) throw new Error(`bad or unknown conversation id ${String(id)}`);
    if (typeof title !== "string" || typeof summary !== "string" || typeof bucket !== "string") throw new Error(`conversation ${id} missing fields`);
    if (!Object.hasOwn(buckets, bucket)) throw new Error(`conversation ${id} unknown bucket ${bucket}`);
    return { id, title, bucket, summary, update: typeof update === "string" && update ? update : null };
  });
  const missing = [...ids].filter((id) => !cards.some((c) => c.id === id));
  if (missing.length) throw new Error(`missing conversations ${missing.join(",")}`);
  return cards;
}
