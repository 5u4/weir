// bun data/update-eval.ts — exercises the `update` field. Real mail rarely spans one global seenCutoff, so each
// multi-item conversation in data.json is split at its middle item: summarize.md sees the first half, then
// incremental.md sees the second half with that summary. Writes data/update-eval.md and logs/update-eval-*.txt.
import { tmpdir } from "node:os";
import { join } from "node:path";
import bucketDefs from "./prompts/buckets.toml";
import { pool, type Data, type Item } from "./shared";

const CMD = ["omp", "-p", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-extensions", "--no-title", "--thinking", "low"];
const BATCH = 8;
const DIR = import.meta.dir;
const data: Data = await Bun.file(join(DIR, "data.json")).json();
const byId = new Map(data.items.map((i) => [i.id, i]));
const bucketText = Object.entries(bucketDefs as Record<string, { name: string; rule: string }>).map(([id, b]) => `- ${id} (${b.name}): ${b.rule}`).join("\n");
const render = (i: Item) => ({
  ...(data.me.includes(i.from.addr) ? { fromMe: true } : {}),
  from: i.from.name ? `${i.from.name} <${i.from.addr}>` : i.from.addr,
  date: i.occurredAt,
  subject: i.subject,
  body: i.bodyNew.slice(0, 1500),
});

async function call(name: string, template: string, payload: unknown): Promise<{ id: string; title: string; summary: string; update: string | null }[]> {
  const prompt = (await Bun.file(join(DIR, "prompts", template)).text())
    .replace("{{ME}}", () => data.me.join(", "))
    .replace("{{BUCKETS}}", () => bucketText)
    .replace("{{DATA}}", () => JSON.stringify(payload, null, 1).replaceAll("<<<EMAIL_DATA_", "<<EMAIL_DATA_"));
  const proc = Bun.spawn(CMD, { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(prompt);
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  await Bun.write(join(DIR, "logs", `update-eval-${name}.txt`), `===== PROMPT =====\n${prompt}\n\n===== STDOUT =====\n${out}`);
  const fence = [...out.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].at(-1);
  if (!fence) throw new Error(`${name}: no JSON fence`);
  return JSON.parse(fence[1]).conversations;
}

const convs = data.conversations
  .map((c) => ({ c, items: c.itemIds.map((id) => byId.get(id)!) }))
  .filter(({ items }) => items.length > 1);
const batches = Array.from({ length: Math.ceil(convs.length / BATCH) }, (_, k) => convs.slice(k * BATCH, (k + 1) * BATCH));
const t0 = performance.now();
const rows = (
  await pool(batches, 3, async (batch, k) => {
    const split = (items: Item[]) => Math.floor(items.length / 2);
    const before = await call(`summarize-${k + 1}`, "summarize.md", batch.map(({ c, items }) => ({ id: c.id, items: items.slice(0, split(items)).map(render) })));
    const prev = new Map(before.map((b) => [b.id, b]));
    const after = await call(
      `incremental-${k + 1}`,
      "incremental.md",
      batch.map(({ c, items }) => ({ id: c.id, previousTitle: prev.get(c.id)?.title ?? null, previousSummary: prev.get(c.id)?.summary ?? null, newItems: items.slice(split(items)).map(render) })),
    );
    return batch.map(({ c, items }) => ({ c, before: split(items), after: items.length - split(items), update: after.find((a) => a.id === c.id)?.update ?? null }));
  })
).flat();
const ms = Math.round(performance.now() - t0);

const md = `# update eval

Run ${new Date().toISOString()} on data.json generated ${data.generatedAt}. ${rows.length} multi-item conversations, each split at its middle item. ${batches.length * 2} calls, ${ms} ms wall at concurrency 3. update non-null: ${rows.filter((r) => r.update).length}/${rows.length}.

| conversation (final title) | threads | items before / after | update |
|---|---|---|---|
${rows.map((r) => `| ${r.c.title} | ${r.c.threadIds.length} | ${r.before} / ${r.after} | ${r.update ?? "(null)"} |`).join("\n")}
`;
await Bun.write(join(DIR, "update-eval.md"), md);
console.log(`update-eval: ${rows.length} conversations, ${rows.filter((r) => r.update).length} updates, ${ms} ms`);
