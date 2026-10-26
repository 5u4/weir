// bun data/r5.ts — builds runs/gpt-6-luna-r5: the gpt-6-luna-low run plus the two synthetic long conversations in
// data/synthetic.json, enriched with per-item gists and per-conversation points. Writes data.json, timing.md, logs/.
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bucketDefs from "./prompts/buckets.toml";
import { checkR5, gistProblem } from "./check-r5";
import { lastJson, parseCards, pool, probeModel, type Addr, type Conversation, type Data, type EnrichRun, type Item, type Point } from "./shared";

const SLUG = "gpt-6-luna-r5";
const LABEL = "gpt-6-luna · 逐条要点 + 合成长对话";
const CMD: string[] = process.env.WEIR_ENRICH_CMD
  ? JSON.parse(process.env.WEIR_ENRICH_CMD)
  : ["omp", "-p", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-extensions", "--no-title", "--model", "gpt-6-luna", "--thinking", "low"];
const CONCURRENCY = 3;
const DIGEST_BATCH_ITEMS = 30;
const DIGEST_BATCH_CHARS = 24_000;
const DIGEST_BODY_CHARS = 1200;
const CONVERSATION_BODY_BUDGET = 5000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const TZ = "America/Vancouver";

type Stage = EnrichRun["stage"];
type Person = { name: string; addr?: string; signature?: string };
type Authored = { at: string; from: string; to?: string[]; cc?: string[]; text: string };
type Synthetic = {
  teams: { channel: string; threadId: string; people: Record<string, Person>; messages: Authored[] };
  mail: { subject: string; label: string; people: Record<string, Person>; messages: Authored[] };
};

const DIR = import.meta.dir;
const OUT = join(DIR, "runs", SLUG);
const LOGS = join(OUT, "logs");
rmSync(LOGS, { recursive: true, force: true });
mkdirSync(LOGS, { recursive: true });

const base: Data = await Bun.file(join(DIR, "runs/gpt-6-luna-low/data.json")).json();
const syn: Synthetic = await Bun.file(join(DIR, "synthetic.json")).json();
const cutoff = base.seenCutoff;
const me = new Set(base.me);
const buckets = bucketDefs as Record<string, { name: string; rule: string }>;
const bucketText = Object.entries(buckets).map(([id, b]) => `- ${id} (${b.name}): ${b.rule}`).join("\n");
const templates: Record<"summarize" | "incremental" | "digest", string> = {
  summarize: await Bun.file(join(DIR, "prompts/summarize.md")).text(),
  incremental: await Bun.file(join(DIR, "prompts/incremental.md")).text(),
  digest: await Bun.file(join(DIR, "prompts/digest.md")).text(),
};
const runs: EnrichRun[] = [];

// ---- synthetic conversations ----

// "me" in synthetic.json has no address so the items always point at whoever data.me names.
const resolve = (people: Record<string, Person>, key: string): Addr => ({ name: people[key].name, addr: people[key].addr ?? base.me[0] });

const teams = syn.teams;
const teamsItems: Item[] = teams.messages.map((m) => {
  const at = new Date(m.at);
  const id = String(at.getTime());
  return {
    id,
    source: "teams",
    sourceLabel: `Teams · #${teams.channel}（合成）`,
    threadId: teams.threadId,
    containerId: `teams:${teams.channel}`,
    from: resolve(teams.people, m.from),
    to: Object.keys(teams.people).filter((k) => k !== m.from).map((k) => resolve(teams.people, k)),
    cc: [],
    subject: `#${teams.channel}`,
    occurredAt: at.toISOString(),
    bodyNew: m.text,
    bodyQuoted: "",
    link: `https://teams.microsoft.com/l/message/${encodeURIComponent(teams.threadId)}/${id}`,
    synthetic: true,
  };
});

const mail = syn.mail;
const mailItems: Item[] = [];
for (const m of mail.messages) {
  const at = new Date(m.at);
  // Gmail message ids are a hex timestamp in the high bits; this keeps synthetic ids looking like the real ones.
  const id = ((BigInt(at.getTime()) << 20n) | (BigInt(Bun.hash(m.text)) & 0xfffffn)).toString(16);
  const prev = mailItems.at(-1);
  const threadId = mailItems[0]?.id ?? id;
  const quoted = prev
    ? `On ${new Date(prev.occurredAt).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric" })} at ${new Date(prev.occurredAt).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" })} ${prev.from.name} <${prev.from.addr}> wrote:\n${`${prev.bodyNew}\n\n${prev.bodyQuoted}`
        .trimEnd()
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n")}`
    : "";
  mailItems.push({
    id,
    source: "gmail",
    sourceLabel: `Gmail · ${mail.label}（合成）`,
    threadId,
    containerId: mail.label,
    from: resolve(mail.people, m.from),
    to: (m.to ?? []).map((k) => resolve(mail.people, k)),
    cc: (m.cc ?? []).map((k) => resolve(mail.people, k)),
    subject: prev ? `Re: ${mail.subject}` : mail.subject,
    occurredAt: at.toISOString(),
    bodyNew: m.text,
    bodyQuoted: [mail.people[m.from].signature ? `-- \n${mail.people[m.from].signature}` : "", quoted].filter(Boolean).join("\n\n"),
    link: `https://mail.google.com/mail/u/0/#all/${threadId}`,
    synthetic: true,
  });
}

const synthConvs: Conversation[] = [teamsItems, mailItems].map((items) => ({
  id: `c-${items[0].threadId}`,
  title: "",
  bucket: null,
  summary: "",
  update: null,
  itemIds: items.map((i) => i.id),
  threadIds: [items[0].threadId!],
  mergeReason: null,
  firstAt: items[0].occurredAt,
  lastAt: items.at(-1)!.occurredAt,
}));

const items: Item[] = [...base.items, ...teamsItems, ...mailItems];
const conversations: Conversation[] = [...base.conversations.map((c) => ({ ...c })), ...synthConvs].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
const itemById = new Map(items.map((i) => [i.id, i]));
const itemsOf = (c: Conversation) => c.itemIds.map((id) => itemById.get(id)!);

// ---- agent ----

const model = await probeModel(CMD);

async function callAgent<T>(
  stage: Stage & keyof typeof templates,
  batch: number,
  payload: unknown,
  counts: { conversations: number; items: number },
  parse: (out: unknown) => T,
): Promise<T | null> {
  const prompt = templates[stage]
    .replace("{{ME}}", () => base.me.join(", "))
    .replace("{{BUCKETS}}", () => bucketText)
    .replace("{{DATA}}", () => JSON.stringify(payload, null, 1).replaceAll("<<<EMAIL_DATA_", "<<EMAIL_DATA_"));
  for (const attempt of [1, 2]) {
    const t0 = performance.now();
    const proc = Bun.spawn(CMD, { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: CALL_TIMEOUT_MS });
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
      `cmd: ${JSON.stringify(CMD)} (prompt via stdin)\nexit: ${code}  ms: ${ms}  ${error ?? "ok"}\n\n===== PROMPT =====\n${prompt}\n\n===== STDOUT =====\n${stdout}\n\n===== STDERR =====\n${stderr}`,
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
const stageWall: Partial<Record<Stage, number>> = {};

// ---- synthetic: summarize earlier items, then incremental over the unread ones (same prompts as enrich.ts) ----

let t0 = performance.now();
const earlier = (c: Conversation) => itemsOf(c).filter((i) => i.occurredAt <= cutoff);
const later = (c: Conversation) => itemsOf(c).filter((i) => i.occurredAt > cutoff);
const synthIds = new Set(synthConvs.map((c) => c.id));
const summarized = await callAgent(
  "summarize",
  1,
  synthConvs.map((c) => ({ id: c.id, items: earlier(c).map((i) => renderItem(i, bodyCap(earlier(c).length))) })),
  { conversations: synthConvs.length, items: synthConvs.reduce((n, c) => n + earlier(c).length, 0) },
  (out) => parseCards(out, synthIds, buckets),
);
for (const card of summarized ?? []) Object.assign(synthConvs.find((c) => c.id === card.id)!, { title: card.title, bucket: card.bucket, summary: card.summary });
stageWall.summarize = Math.round(performance.now() - t0);

t0 = performance.now();
const incremented = await callAgent(
  "incremental",
  1,
  synthConvs.map((c) => ({
    id: c.id,
    previousTitle: c.summary ? c.title : null,
    previousSummary: c.summary || null,
    newItems: (c.summary ? later(c) : itemsOf(c)).map((i, _, all) => renderItem(i, bodyCap(all.length))),
  })),
  { conversations: synthConvs.length, items: synthConvs.reduce((n, c) => n + later(c).length, 0) },
  (out) => parseCards(out, synthIds, buckets),
);
for (const card of incremented ?? []) {
  const c = synthConvs.find((s) => s.id === card.id)!;
  Object.assign(c, { title: card.title, bucket: card.bucket, update: c.summary ? card.update : null, summary: card.summary });
}
stageWall.incremental = Math.round(performance.now() - t0);

// ---- digest: gists for every item, points for every conversation ----

type Digest = { gists: Record<string, string>; points: Point[] };
function parseDigest(out: unknown, batch: Conversation[]): Map<string, Digest> {
  const { conversations: list } = (typeof out === "object" && out !== null ? out : {}) as { conversations?: unknown };
  if (!Array.isArray(list)) throw new Error("expected {conversations: []}");
  const result = new Map<string, Digest>();
  for (const entry of list) {
    const { id, gists, points } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const conv = batch.find((c) => c.id === id);
    if (!conv) throw new Error(`bad or unknown conversation id ${String(id)}`);
    if (typeof gists !== "object" || gists === null || !Array.isArray(points)) throw new Error(`conversation ${conv.id} missing gists or points`);
    // Items are addressed by short refs (m1, m2, ...) because the model miscopies long hex message ids.
    const gistByRef = gists as Record<string, unknown>;
    const itemIdByRef = Object.fromEntries(conv.itemIds.map((itemId, k) => [`m${k + 1}`, itemId]));
    for (const [ref, itemId] of Object.entries(itemIdByRef)) {
      const problem = gistProblem(gistByRef[ref]);
      if (problem) throw new Error(`item ${itemId} (${ref}) gist ${problem}`);
    }
    if (points.length > 5) throw new Error(`conversation ${conv.id} has ${points.length} points`);
    const parsed = points.map((p: unknown): Point => {
      const { kind, text, ref } = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
      if (kind !== "ask" && kind !== "decision" && kind !== "date" && kind !== "info") throw new Error(`conversation ${conv.id} bad point kind ${String(kind)}`);
      if (typeof text !== "string" || !text.trim()) throw new Error(`conversation ${conv.id} empty point text`);
      const itemId = itemIdByRef[String(ref)];
      if (!itemId) throw new Error(`conversation ${conv.id} point cites unknown ref ${String(ref)}`);
      return { kind, text, itemId };
    });
    // The model drifts into "Marcus 提议…" late in long batches despite the prompt; every UI shows the sender beside the gist.
    const gistFor = (ref: string, itemId: string) => {
      const gist = (gistByRef[ref] as string).trim();
      const first = itemById.get(itemId)!.from.name.split(" ")[0];
      const rest = first.length > 1 && gist.startsWith(first) ? gist.slice(first.length).trimStart() : "";
      return gistProblem(rest) ? gist : rest;
    };
    result.set(conv.id, { gists: Object.fromEntries(Object.entries(itemIdByRef).map(([ref, itemId]) => [itemId, gistFor(ref, itemId)])), points: parsed });
  }
  const missing = batch.filter((c) => !result.has(c.id)).map((c) => c.id);
  if (missing.length) throw new Error(`missing conversations ${missing.join(",")}`);
  return result;
}

const digestPayload = (c: Conversation) => ({
  id: c.id,
  title: c.title,
  summary: c.summary,
  items: itemsOf(c).map((i, k) => ({ ref: `m${k + 1}`, ...renderItem(i, DIGEST_BODY_CHARS) })),
});
// Pack whole conversations greedily; a conversation bigger than the limits gets a batch of its own.
const batches: Conversation[][] = [];
let current: Conversation[] = [];
let currentItems = 0;
let currentChars = 0;
for (const c of conversations) {
  const chars = JSON.stringify(digestPayload(c)).length;
  if (current.length && (currentItems + c.itemIds.length > DIGEST_BATCH_ITEMS || currentChars + chars > DIGEST_BATCH_CHARS)) {
    batches.push(current);
    current = [];
    currentItems = 0;
    currentChars = 0;
  }
  current.push(c);
  currentItems += c.itemIds.length;
  currentChars += chars;
}
if (current.length) batches.push(current);

t0 = performance.now();
await pool(batches, CONCURRENCY, async (batch, k) => {
  const digests = await callAgent(
    "digest",
    k + 1,
    batch.map(digestPayload),
    { conversations: batch.length, items: batch.reduce((n, c) => n + c.itemIds.length, 0) },
    (out) => parseDigest(out, batch),
  );
  for (const [id, d] of digests ?? []) {
    const c = conversations.find((x) => x.id === id)!;
    c.points = d.points;
    for (const itemId of c.itemIds) itemById.get(itemId)!.gist = d.gists[itemId];
  }
});
stageWall.digest = Math.round(performance.now() - t0);

// ---- write ----

const final: Data = { ...base, items, conversations, enrichRuns: [...base.enrichRuns, ...runs] };
const errs = checkR5(final);
if (!errs.length) {
  const tmp = join(OUT, "data.json.tmp");
  await Bun.write(tmp, JSON.stringify(final, null, 1));
  renameSync(tmp, join(OUT, "data.json"));
  const indexPath = join(DIR, "runs/index.json");
  const index: { runs: { slug: string; label: string }[] } = await Bun.file(indexPath).json();
  if (!index.runs.some((r) => r.slug === SLUG)) {
    index.runs.push({ slug: SLUG, label: LABEL });
    await Bun.write(indexPath, `${JSON.stringify(index, null, 1)}\n`);
  }
}

const gistLengths = items.filter((i) => i.gist).map((i) => (i.gist!.match(/\p{Script=Han}/gu) ?? []).length).sort((a, b) => a - b);
const pointCounts = conversations.map((c) => c.points?.length ?? 0);
const kindCount = (kind: string) => conversations.reduce((n, c) => n + (c.points ?? []).filter((p) => p.kind === kind).length, 0);
const failures = runs.filter((r) => !r.ok);
const timing = `# weir-proto r5 run timing

Measured by \`bun data/r5.ts\` on ${new Date().toISOString()}. Base: \`runs/gpt-6-luna-low/data.json\` (${base.items.length} items, ${base.conversations.length} conversations, seenCutoff ${cutoff}) plus the two synthetic conversations authored in \`data/synthetic.json\`.

- Model: \`${model}\` (read from a JSON-mode probe call before the stages).
- Agent command: \`${CMD.join(" ")}\`, prompt passed on stdin.
- Concurrency ${CONCURRENCY}. Synthetic summarize/incremental use \`prompts/summarize.md\` / \`prompts/incremental.md\` (one call each, both conversations). Digest (\`prompts/digest.md\`) packs whole conversations up to ${DIGEST_BATCH_ITEMS} items or ${DIGEST_BATCH_CHARS} payload chars per call, bodies truncated to ${DIGEST_BODY_CHARS} chars. A failed call is retried once.

## Synthetic conversations

| conversation | source | items | unread (after seenCutoff) | bucket | title |
|---|---|---|---|---|---|
${synthConvs.map((c) => `| ${c.id} | ${itemsOf(c)[0].sourceLabel} | ${c.itemIds.length} | ${later(c).length} | ${c.bucket} | ${c.title} |`).join("\n")}

## Calls

Total calls ${runs.length} (${runs.length - failures.length} ok, ${failures.length} failed). Total wall ${Object.values(stageWall).reduce((a, b) => a + b, 0)} ms (${Object.entries(stageWall).map(([s, ms]) => `${s} ${ms}`).join(", ")}); sum of call durations ${runs.reduce((n, r) => n + r.ms, 0)} ms.

| stage | batch | conversations | items | input chars | output chars | ms | ok | error |
|---|---|---|---|---|---|---|---|---|
${runs.map((r) => `| ${r.stage} | ${r.batch} | ${r.conversations} | ${r.items} | ${r.inputChars} | ${r.outputChars} | ${r.ms} | ${r.ok ? "yes" : "no"} | ${r.error ?? ""} |`).join("\n")}

## Output

- Gists: ${gistLengths.length} / ${items.length} items. Chinese characters per gist: median ${gistLengths[Math.floor(gistLengths.length / 2)] ?? 0}, max ${gistLengths.at(-1) ?? 0}, over 40: ${gistLengths.filter((n) => n > 40).length}.
- Points: ${pointCounts.reduce((a, b) => a + b, 0)} across ${conversations.length} conversations; ${pointCounts.filter((n) => n === 0).length} conversations have none. By kind: ask ${kindCount("ask")}, decision ${kindCount("decision")}, date ${kindCount("date")}, info ${kindCount("info")}.

## Check (\`bun data/check-r5.ts\`)

${errs.length ? `FAILED, data.json not written:\n\n${errs.map((e) => `- ${e}`).join("\n")}` : "ok"}
`;
await Bun.write(join(OUT, "timing.md"), timing);

console.log(errs.length ? `CHECK FAILED\n${errs.join("\n")}` : `check ok: ${items.length} items, ${conversations.length} conversations, ${runs.length} calls, ${failures.length} failed`);
process.exit(errs.length ? 1 : 0);
