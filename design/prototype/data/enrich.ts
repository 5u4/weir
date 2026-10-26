// bun data/enrich.ts — reads data/fetched.json, runs group → summarize → incremental through an
// agent CLI, writes data/data.json, data/timing.md, and data/logs/<stage>-<batch>.txt.
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bucketDefs from "./prompts/buckets.toml";
import { check } from "./check";
import { chunk, lastJson, parseCards, pool, probeModel, type Addr, type Conversation, type Data, type EnrichRun, type Item } from "./shared";

const ENRICH_CMD: string[] = process.env.WEIR_ENRICH_CMD
  ? JSON.parse(process.env.WEIR_ENRICH_CMD)
  : ["omp", "-p", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-extensions", "--no-title", "--thinking", "low"];
const CONCURRENCY = 3;
const SUMMARY_BATCH = 8;
const GROUP_CARD_BODY_CHARS = 120;
const CONVERSATION_BODY_BUDGET = 5000;
const CALL_TIMEOUT_MS = 5 * 60_000;

type Stage = Exclude<EnrichRun["stage"], "digest">;
type Thread = { threadId: string; items: Item[] };

const DIR = import.meta.dir;
const OUT = process.env.OUT_DIR ?? DIR;
const LOGS = join(OUT, "logs");
rmSync(LOGS, { recursive: true, force: true });
mkdirSync(LOGS, { recursive: true });

const { windowDays, ...data }: Data & { windowDays: number } = await Bun.file(join(DIR, "fetched.json")).json();
const cutoff = data.seenCutoff;
const me = new Set(data.me);
const runs: EnrichRun[] = [];
const buckets = bucketDefs as Record<string, { name: string; rule: string }>;
const bucketText = Object.entries(buckets).map(([id, b]) => `- ${id} (${b.name}): ${b.rule}`).join("\n");
const templates = {
  group: await Bun.file(join(DIR, "prompts/group.md")).text(),
  summarize: await Bun.file(join(DIR, "prompts/summarize.md")).text(),
  incremental: await Bun.file(join(DIR, "prompts/incremental.md")).text(),
};

const model = await probeModel(ENRICH_CMD);

async function callAgent<T>(
  stage: Stage,
  batch: number,
  payload: unknown,
  counts: { conversations: number; items: number },
  parse: (out: unknown) => T,
): Promise<T | null> {
  const prompt = templates[stage]
    .replace("{{ME}}", () => data.me.join(", "))
    .replace("{{BUCKETS}}", () => bucketText)
    .replace("{{DATA}}", () => JSON.stringify(payload, null, 1).replaceAll("<<<EMAIL_DATA_", "<<EMAIL_DATA_"));
  for (const attempt of [1, 2]) {
    const t0 = performance.now();
    const proc = Bun.spawn(ENRICH_CMD, { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: CALL_TIMEOUT_MS });
    proc.stdin.write(prompt);
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const ms = Math.round(performance.now() - t0);
    let value: T | undefined;
    let error: string | undefined;
    try {
      if (code !== 0) throw new Error(`exit ${code}`);
      value = parse(lastJson(stdout));
    } catch (e) {
      error = `attempt ${attempt}: ${e instanceof Error ? e.message : String(e)}`;
    }
    runs.push({ stage, batch, ...counts, inputChars: prompt.length, outputChars: stdout.length, ms, ok: !error, ...(error ? { error } : {}) });
    await Bun.write(
      join(LOGS, `${stage}-${batch}${attempt > 1 ? "-retry" : ""}.txt`),
      `cmd: ${JSON.stringify(ENRICH_CMD)} (prompt via stdin)\nexit: ${code}  ms: ${ms}  ${error ?? "ok"}\n\n===== PROMPT =====\n${prompt}\n\n===== STDOUT =====\n${stdout}\n\n===== STDERR =====\n${stderr}`,
    );
    console.log(`${stage} batch ${batch} attempt ${attempt}: ${ms}ms ${error ?? "ok"}`);
    if (!error) return value as T;
  }
  return null;
}

const renderItem = (i: Item, cap: number) => ({
  ...(me.has(i.from.addr) ? { fromMe: true } : {}),
  from: i.from.name ? `${i.from.name} <${i.from.addr}>` : i.from.addr,
  to: i.to.map((a) => a.addr),
  ...(i.cc.length ? { cc: i.cc.map((a) => a.addr) } : {}),
  date: i.occurredAt,
  subject: i.subject,
  label: i.sourceLabel,
  body: i.bodyNew.length > cap ? `${i.bodyNew.slice(0, cap)}…` : i.bodyNew,
});
const bodyCap = (n: number) => Math.max(400, Math.floor(CONVERSATION_BODY_BUDGET / n));

// ---- group ----

const threads: Thread[] = [...Map.groupBy(data.items, (i) => i.threadId ?? i.id)].map(([threadId, items]) => ({ threadId, items }));
threads.sort((a, b) => a.items.at(-1)!.occurredAt.localeCompare(b.items.at(-1)!.occurredAt));

const parent = new Map(threads.map((t) => [t.threadId, t.threadId]));
const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));
const reasons = new Map<string, string[]>();

// All threads go in one call: a matter whose threads land in different batches can never merge.
const allThreadIds = new Set(threads.map((t) => t.threadId));
const who = (a: Addr) => (a.name ? `${a.name} @${a.addr.split("@")[1] ?? a.addr}` : a.addr);
const cards = threads.map((t) => {
  const first = t.items[0];
  return {
    threadId: t.threadId,
    subject: first.subject,
    from: me.has(first.from.addr) ? `me → ${first.to.slice(0, 2).map(who).join(", ")}` : who(first.from),
    date: first.occurredAt.slice(0, 16),
    ...(t.items.length > 1 ? { messages: t.items.length } : {}),
    start: first.bodyNew.replace(/\s+/g, " ").slice(0, GROUP_CARD_BODY_CHARS),
  };
});
let t0 = performance.now();
const merges = await callAgent("group", 1, cards, { conversations: threads.length, items: data.items.length }, (out) => {
  // Model output: every field starts as unknown and is checked with typeof below.
  const { merges } = (typeof out === "object" && out !== null ? out : {}) as { merges?: unknown };
  if (!Array.isArray(merges)) throw new Error("expected {merges: []}");
  return merges.map((m: unknown) => {
    const { threadIds, reason } = (typeof m === "object" && m !== null ? m : {}) as { threadIds?: unknown; reason?: unknown };
    if (!Array.isArray(threadIds) || typeof reason !== "string") throw new Error("bad merge entry");
    const tids = threadIds.map(String);
    const unknown = tids.filter((id) => !allThreadIds.has(id));
    if (unknown.length) throw new Error(`unknown threadIds ${unknown.join(",")}`);
    return { threadIds: tids, reason };
  });
});
for (const m of merges ?? []) {
  if (new Set(m.threadIds).size < 2) continue;
  for (const id of m.threadIds.slice(1)) parent.set(root(id), root(m.threadIds[0]));
  reasons.set(m.threadIds[0], [...(reasons.get(m.threadIds[0]) ?? []), m.reason]);
}
const stageWall: Partial<Record<Stage, number>> = { group: Math.round(performance.now() - t0) };

const groups = Map.groupBy(threads, (t) => root(t.threadId));
const conversations: Conversation[] = [...groups.values()].map((ts) => {
  ts.sort((a, b) => a.items[0].occurredAt.localeCompare(b.items[0].occurredAt));
  const items = ts.flatMap((t) => t.items).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const why = ts.flatMap((t) => reasons.get(t.threadId) ?? []);
  return {
    id: `c-${ts[0].threadId}`,
    title: items[0].subject,
    bucket: null,
    summary: "",
    update: null,
    itemIds: items.map((i) => i.id),
    threadIds: ts.map((t) => t.threadId),
    mergeReason: ts.length > 1 ? why.join("；") : null,
    firstAt: items[0].occurredAt,
    lastAt: items.at(-1)!.occurredAt,
  };
});
conversations.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
const itemById = new Map(data.items.map((i) => [i.id, i]));
const itemsOf = (c: Conversation) => c.itemIds.map((id) => itemById.get(id)!);

// ---- summarize / incremental ----

const byConvId = new Map(conversations.map((c) => [c.id, c]));
const earlierItems = (c: Conversation) => itemsOf(c).filter((i) => i.occurredAt <= cutoff);

t0 = performance.now();
const toSummarize = conversations.filter((c) => earlierItems(c).length);
await pool(chunk(toSummarize, SUMMARY_BATCH), CONCURRENCY, async (batch, k) => {
  const payload = batch.map((c) => {
    const its = earlierItems(c);
    return { id: c.id, items: its.map((i) => renderItem(i, bodyCap(its.length))) };
  });
  const counts = { conversations: batch.length, items: batch.reduce((n, c) => n + earlierItems(c).length, 0) };
  const cards = await callAgent("summarize", k + 1, payload, counts, (out) => parseCards(out, new Set(batch.map((c) => c.id)), buckets));
  for (const card of cards ?? []) Object.assign(byConvId.get(card.id)!, { title: card.title, bucket: card.bucket, summary: card.summary });
});
stageWall.summarize = Math.round(performance.now() - t0);

t0 = performance.now();
const toIncrement = conversations.filter((c) => itemsOf(c).some((i) => i.occurredAt > cutoff));
// A conversation with earlier items but a failed summarize has nothing to diff against, so it is rebuilt from all its items.
const hasPrevious = new Set(toIncrement.filter((c) => c.summary).map((c) => c.id));
await pool(chunk(toIncrement, SUMMARY_BATCH), CONCURRENCY, async (batch, k) => {
  const newItemsOf = (c: Conversation) => itemsOf(c).filter((i) => !hasPrevious.has(c.id) || i.occurredAt > cutoff);
  const payload = batch.map((c) => {
    const its = newItemsOf(c);
    const prev = hasPrevious.has(c.id);
    return { id: c.id, previousTitle: prev ? c.title : null, previousSummary: prev ? c.summary : null, newItems: its.map((i) => renderItem(i, bodyCap(its.length))) };
  });
  const counts = { conversations: batch.length, items: batch.reduce((n, c) => n + newItemsOf(c).length, 0) };
  const cards = await callAgent("incremental", k + 1, payload, counts, (out) => parseCards(out, new Set(batch.map((c) => c.id)), buckets));
  for (const card of cards ?? []) {
    const c = byConvId.get(card.id)!;
    Object.assign(c, { title: card.title, bucket: card.bucket, summary: card.summary, update: hasPrevious.has(c.id) ? card.update : null });
  }
});
stageWall.incremental = Math.round(performance.now() - t0);

// ---- write ----

const final: Data = { ...data, conversations, enrichRuns: runs };
await Bun.write(join(OUT, "data.json"), JSON.stringify(final, null, 1));

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { avg: Math.round(s.reduce((a, b) => a + b, 0) / (s.length || 1)), median: s[Math.floor(s.length / 2)] ?? 0, max: s.at(-1) ?? 0 };
};
const stageRows = (["group", "summarize", "incremental"] as Stage[]).map((stage) => {
  const rs = runs.filter((r) => r.stage === stage);
  const ok = rs.filter((r) => r.ok);
  const st = stats(rs.map((r) => r.ms));
  const totalMs = rs.reduce((n, r) => n + r.ms, 0);
  const convs = ok.reduce((n, r) => n + r.conversations, 0);
  const avgIn = Math.round(rs.reduce((n, r) => n + r.inputChars, 0) / (rs.length || 1));
  const avgOut = Math.round(rs.reduce((n, r) => n + r.outputChars, 0) / (rs.length || 1));
  return `| ${stage} | ${rs.length} | ${ok.length} | ${rs.length - ok.length} | ${stageWall[stage] ?? 0} | ${totalMs} | ${st.avg} | ${st.median} | ${st.max} | ${convs ? Math.round(totalMs / convs) : "-"} | ${avgIn} | ${avgOut} |`;
});
const merged = conversations.filter((c) => c.threadIds.length > 1);
const threadById = new Map(threads.map((t) => [t.threadId, t]));
const failures = runs.filter((r) => !r.ok);
const unbucketed = conversations.filter((c) => c.bucket === null);
const cutoffHours = Math.round((Date.parse(data.generatedAt) - Date.parse(cutoff)) / 3600_000);
const spanning = conversations.filter((c) => itemsOf(c).some((i) => i.occurredAt <= cutoff) && itemsOf(c).some((i) => i.occurredAt > cutoff));
const timing = `# weir-proto enrich timing

Measured by \`bun data/enrich.ts\` on ${new Date().toISOString()}. Mailbox query window: last ${windowDays} days (\`newer_than:${windowDays}d\`). Data generated ${data.generatedAt}; seenCutoff ${cutoff} (${cutoffHours} h before).

- Model: \`${model}\` (read from a JSON-mode probe call before the stages).
- Agent command: \`${ENRICH_CMD.join(" ")}\`, prompt passed on stdin.
- Concurrency ${CONCURRENCY}; group is one call over all ${threads.length} threads (≤ ${GROUP_CARD_BODY_CHARS} body chars per card); summarize/incremental batches ≤ ${SUMMARY_BATCH} conversations.

## Counts

| messages | threads | conversations | merged conversations | items ≤ cutoff | items > cutoff | span cutoff | summarized | incremental (with previous summary / from scratch) | update non-null | bucket null |
|---|---|---|---|---|---|---|---|---|---|---|
| ${data.items.length} | ${threads.length} | ${conversations.length} | ${merged.length} | ${data.items.filter((i) => i.occurredAt <= cutoff).length} | ${data.items.filter((i) => i.occurredAt > cutoff).length} | ${spanning.length} | ${toSummarize.length} | ${toIncrement.length} (${hasPrevious.size} / ${toIncrement.length - hasPrevious.size}) | ${conversations.filter((c) => c.update).length} | ${unbucketed.length} |

## Per stage

Calls include retries. "wall" is the stage's elapsed time with ${CONCURRENCY} calls in flight; "sum" adds every call's own duration. ms/conv = sum ÷ conversations in successful calls.

| stage | calls | ok | failed | wall ms | sum ms | avg ms | median ms | max ms | ms/conv | avg input chars | avg output chars |
|---|---|---|---|---|---|---|---|---|---|---|---|
${stageRows.join("\n")}

Total wall: ${Object.values(stageWall).reduce((a, b) => a + b, 0)} ms.

## Buckets

${final.buckets.map((b) => `- ${b.id} ${b.name}: ${conversations.filter((c) => c.bucket === b.id).length}`).join("\n")}
- null 未分类: ${unbucketed.length}

## Merges (${merged.length})

${merged
  .map(
    (c) =>
      `### ${c.title}\n\nReason: ${c.mergeReason}\n\n${c.threadIds
        .map((id) => {
          const t = threadById.get(id)!;
          return `- ${t.items[0].subject} (${t.items.length} msg, ${t.items[0].from.addr}, ${t.items[0].occurredAt.slice(0, 16)})`;
        })
        .join("\n")}`,
  )
  .join("\n\n") || "None."}

## Failures (${failures.length})

${failures.map((r) => `- ${r.stage} batch ${r.batch}: ${r.error}`).join("\n") || "None."}
`;
await Bun.write(join(OUT, "timing.md"), timing);

const errs = check(final);
console.log(errs.length ? `CHECK FAILED\n${errs.join("\n")}` : `check ok: ${conversations.length} conversations, ${merged.length} merged, ${failures.length} failed calls`);
process.exit(errs.length ? 1 : 0);
