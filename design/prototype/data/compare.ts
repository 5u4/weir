// bun data/compare.ts — compares every run in data/runs/index.json against the first (baseline). Writes data/runs/compare.md.
import { join } from "node:path";
import type { Conversation, Data, Item } from "./shared";

const RUNS = join(import.meta.dir, "runs");
const { runs: index }: { runs: { slug: string; label: string }[] } = await Bun.file(join(RUNS, "index.json")).json();
type Run = { slug: string; label: string; data: Data; timing: string; model: string; thinking: string };
const runs: Run[] = await Promise.all(
  index.map(async ({ slug, label }) => {
    const timing = await Bun.file(join(RUNS, slug, "timing.md")).text();
    const cmd = timing.match(/Agent command: `([^`]+)`/)?.[1] ?? "";
    return {
      slug,
      label,
      data: await Bun.file(join(RUNS, slug, "data.json")).json(),
      timing,
      model: timing.match(/Model: `([^`]+)`/)?.[1] ?? "?",
      thinking: cmd.match(/--thinking (\S+)/)?.[1] ?? "?",
    };
  }),
);
const [base, ...others] = runs;
const items = base.data.items;
const threads = [...Map.groupBy(items, (i: Item) => i.threadId ?? i.id)].map(([id, its]) => ({ id, items: its.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) }));
const threadById = new Map(threads.map((t) => [t.id, t]));
const me = new Set(base.data.me);
const bucketIds = [...base.data.buckets.map((b) => b.id), "null"];

const convOfThread = (r: Run) => {
  const m = new Map<string, Conversation>();
  for (const c of r.data.conversations) for (const t of c.threadIds) m.set(t, c);
  return m;
};
const bucketOfThread = (r: Run) => new Map([...convOfThread(r)].map(([t, c]) => [t, c.bucket ?? "null"]));
const mergeKeys = (r: Run) => new Set(r.data.conversations.filter((c) => c.threadIds.length > 1).map((c) => [...c.threadIds].sort().join("+")));

const AUTOMATED = /no-?reply|notif|news|updates?@|info@|hello@|support@|alerts?@|marketing|mailer|account|billing|team@|digest|confirm|shipment|receipts?@|bounce|do-not-reply/i;
// Hand-checked in this mailbox: the only senders that write to me personally. Self-sent digests (me → me) are not human mail.
const HUMAN_SENDERS = /^(sam@foltio\.org|messenger@associationvoice\.com)$/;
const isHuman = (t: (typeof threads)[number]) =>
  t.items.some((i) => me.has(i.from.addr) && i.to.some((a) => !me.has(a.addr))) || t.items.some((i) => HUMAN_SENDERS.test(i.from.addr));
const isAutomated = (t: (typeof threads)[number]) => AUTOMATED.test(t.items[0].from.addr) && !isHuman(t);
const sender = (t: (typeof threads)[number]) => (t.items[0].from.name ? `${t.items[0].from.name} <${t.items[0].from.addr}>` : t.items[0].from.addr);
const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\s+/g, " ");

// ---- headline table ----

function stageWall(timing: string, stage: string) {
  const row = timing.split("\n").find((l) => l.startsWith(`| ${stage} |`))?.split("|").map((s) => s.trim());
  return row ? { calls: +row[2], wall: +row[5], avg: +row[7] } : { calls: 0, wall: 0, avg: 0 };
}
const headline = runs.map((r) => {
  const er = r.data.enrichRuns;
  const failed = er.filter((x) => !x.ok);
  const attemptsByBatch = Map.groupBy(er, (x) => `${x.stage}-${x.batch}`);
  const retries = [...attemptsByBatch.values()].filter((xs) => xs.length > 1).length;
  const lostBatches = [...attemptsByBatch.values()].filter((xs) => !xs.some((x) => x.ok)).length;
  const parseFail = failed.filter((x) => !/exit|timed? ?out|rate|429/i.test(x.error ?? "")).length;
  const convs = r.data.conversations;
  const sums = convs.filter((c) => c.summary);
  const st = ["group", "summarize", "incremental"].map((s) => stageWall(r.timing, s));
  const total = r.timing.match(/Total wall: (\d+) ms/)?.[1] ?? "?";
  return `| ${r.slug} | \`${r.model}\` | ${r.thinking} | ${total} | ${st.map((s) => `${s.wall} / ${s.avg}`).join(" | ")} | ${failed.length} / ${retries} / ${lostBatches} | ${parseFail} | ${convs.length} | ${convs.filter((c) => c.threadIds.length > 1).length} | ${convs.filter((c) => c.bucket === null).length} | ${Math.round(sums.reduce((n, c) => n + c.summary.length, 0) / (sums.length || 1))} |`;
});

// ---- classification drift ----

const baseBucket = bucketOfThread(base);
const drift = others.map((r) => {
  const rb = bucketOfThread(r);
  const matrix = new Map(bucketIds.map((b) => [b, new Map(bucketIds.map((c) => [c, 0]))]));
  const disagreements: string[] = [];
  let agree = 0;
  for (const t of threads) {
    const a = baseBucket.get(t.id) ?? "null";
    const b = rb.get(t.id) ?? "null";
    matrix.get(a)!.set(b, matrix.get(a)!.get(b)! + 1);
    if (a === b) agree++;
    else disagreements.push(`| ${cell(t.items[0].subject).slice(0, 90)} | ${cell(sender(t)).slice(0, 60)} | ${isHuman(t) ? "human" : isAutomated(t) ? "auto" : "?"} | ${a} → ${b} |`);
  }
  const humanThreads = threads.filter(isHuman);
  const humanAgree = humanThreads.filter((t) => baseBucket.get(t.id) === rb.get(t.id)).length;
  const actionBase = threads.filter((t) => baseBucket.get(t.id) === "action");
  const actionKept = actionBase.filter((t) => rb.get(t.id) === "action").length;
  const actionAdded = threads.filter((t) => rb.get(t.id) === "action" && baseBucket.get(t.id) !== "action").length;
  const pct = (a: number, b: number) => `${((100 * a) / (b || 1)).toFixed(1)}%`;
  const bm = mergeKeys(base);
  const rm = mergeKeys(r);
  const describe = (key: string) =>
    key
      .split("+")
      .map((id) => {
        const t = threadById.get(id)!;
        return `"${cell(t.items[0].subject).slice(0, 60)}" (${t.items[0].from.addr})`;
      })
      .join(" + ");
  const onlyBase = [...bm].filter((k) => !rm.has(k));
  const onlyRun = [...rm].filter((k) => !bm.has(k));
  return {
    r,
    agreeLine: `| ${r.slug} | ${agree}/${threads.length} (${pct(agree, threads.length)}) | ${agree}/${threads.filter((t) => rb.get(t.id) !== "null").length} (${pct(agree, threads.filter((t) => rb.get(t.id) !== "null").length)}) | ${humanAgree}/${humanThreads.length} (${pct(humanAgree, humanThreads.length)}) | ${actionKept}/${actionBase.length} (${pct(actionKept, actionBase.length)}) | ${actionAdded} | ${[...bm].filter((k) => rm.has(k)).length} | ${onlyBase.length} | ${onlyRun.length} |`,
    section: `### ${r.slug} (${r.label})

Thread-level agreement ${agree}/${threads.length} (${pct(agree, threads.length)}).

Confusion matrix (rows = baseline ${base.slug}, columns = ${r.slug}):

| baseline \\ run | ${bucketIds.join(" | ")} |
|---|${bucketIds.map(() => "---").join("|")}|
${bucketIds.map((a) => `| **${a}** | ${bucketIds.map((b) => matrix.get(a)!.get(b)).join(" | ")} |`).join("\n")}

Disagreements (${disagreements.length}):

| subject | sender | kind | ${base.slug} → ${r.slug} |
|---|---|---|---|
${disagreements.join("\n") || "| none | | | |"}

Grouping: merges only in ${base.slug} (${onlyBase.length}):
${onlyBase.map((k) => `- ${describe(k)}`).join("\n") || "- none"}

Merges only in ${r.slug} (${onlyRun.length}):
${onlyRun.map((k) => `- ${describe(k)}`).join("\n") || "- none"}
`,
  };
});

// ---- samples ----

const allBuckets = runs.map(bucketOfThread);
const contested = (t: (typeof threads)[number]) => new Set(allBuckets.map((m) => m.get(t.id))).size;
const pick = (pred: (t: (typeof threads)[number]) => boolean, n: number) => {
  const seen = new Set<string>();
  return threads
    .filter(pred)
    .sort((a, b) => contested(b) - contested(a) || b.items.length - a.items.length || a.id.localeCompare(b.id))
    .filter((t) => !seen.has(t.items[0].from.addr) && !!seen.add(t.items[0].from.addr))
    .slice(0, n);
};
const human = pick(isHuman, 4);
const auto = pick(isAutomated, 8 - human.length);
const convMaps = runs.map(convOfThread);
const samples = [...human.map((t) => ["human", t] as const), ...auto.map((t) => ["auto", t] as const)].map(([kind, t]) => {
  const rows = runs.map((r, k) => {
    const c = convMaps[k].get(t.id);
    return `| ${r.slug} | ${c?.bucket ?? "null"} | ${cell(c?.title ?? "-")} | ${cell(c?.summary ?? "-")} |`;
  });
  return `### ${cell(t.items[0].subject)} (${kind}, ${t.items.length} msg, ${sender(t)})

| run | bucket | title | summary |
|---|---|---|---|
${rows.join("\n")}
`;
});

const md = `# Enrich model bakeoff

Generated ${new Date().toISOString()} by \`bun data/compare.ts\`. Every run enriched the same \`data/fetched.json\` (${items.length} messages, ${threads.length} threads, same seenCutoff) with the same prompts; only the agent model and thinking level differ. Baseline \`${base.slug}\` is a reference, not ground truth: every disagreement is listed for a human to judge.

## Runs

wall/avg = stage wall ms (3 calls in flight) / average per-call ms. failed / retried / lost = failed calls, batches that needed a retry, batches whose both attempts failed (their conversations keep a fallback title and bucket null). parse fail = failures from output parsing or schema checks, not process exit.

| run | model | thinking | total wall ms | group wall/avg | summarize wall/avg | incremental wall/avg | failed / retried / lost | parse fail | conversations | merges | null buckets | avg summary chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${headline.join("\n")}

## Agreement with ${base.slug} (thread level)

Each gmail thread takes the bucket of the conversation that contains it. human = a thread where I wrote to someone else, or from a hand-checked personal sender (${HUMAN_SENDERS.source}). action kept = baseline \`action\` threads the run also put in \`action\`; action added = threads the run put in \`action\` that the baseline did not.

| run | all threads | threads the run bucketed (excludes lost batches) | human threads | action kept | action added | shared merges | merges only in baseline | merges only in run |
|---|---|---|---|---|---|---|---|---|
${drift.map((d) => d.agreeLine).join("\n")}

## Classification and grouping drift per run

${drift.map((d) => d.section).join("\n")}
## Side-by-side samples

Human-written threads (one per sender) then automated threads (one per sender), eight in all, preferring threads where runs disagree on the bucket.

${samples.join("\n")}`;
await Bun.write(join(RUNS, "compare.md"), md);
console.log(md.split("## Classification and grouping drift")[0]);
