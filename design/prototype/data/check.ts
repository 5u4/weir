// bun data/check.ts — validates data/data.json against CONTRACT.md invariants.
import { join } from "node:path";
import type { Data } from "./shared";

export function check(d: Data): string[] {
  const errs: string[] = [];
  const bucketIds = new Set(d.buckets.map((b) => b.id));
  const itemIds = new Set(d.items.map((i) => i.id));
  const owner = new Map<string, string>();
  for (const t of [d.generatedAt, d.seenCutoff]) if (Number.isNaN(Date.parse(t))) errs.push(`bad timestamp ${t}`);
  if (!d.me.length || !Array.isArray(d.enrichRuns)) errs.push("missing me or enrichRuns");
  for (const i of d.items) {
    if (!["gmail", "teams"].includes(i.source) || typeof i.from?.addr !== "string" || !Array.isArray(i.to) || !Array.isArray(i.cc)) errs.push(`item ${i.id} bad shape`);
    if (typeof i.bodyNew !== "string" || typeof i.bodyQuoted !== "string" || !i.link || Number.isNaN(Date.parse(i.occurredAt))) errs.push(`item ${i.id} bad fields`);
  }
  for (const c of d.conversations) {
    if (c.bucket !== null && !bucketIds.has(c.bucket)) errs.push(`conversation ${c.id} unknown bucket ${c.bucket}`);
    if (typeof c.title !== "string" || typeof c.summary !== "string" || !(c.update === null || typeof c.update === "string")) errs.push(`conversation ${c.id} bad text fields`);
    if (!c.itemIds.length || !c.threadIds.length || (c.threadIds.length > 1) !== (c.mergeReason !== null)) errs.push(`conversation ${c.id} bad ids/mergeReason`);
    for (const id of c.itemIds) {
      if (!itemIds.has(id)) errs.push(`conversation ${c.id} references missing item ${id}`);
      if (owner.has(id)) errs.push(`item ${id} in both ${owner.get(id)} and ${c.id}`);
      owner.set(id, c.id);
    }
    const times = c.itemIds.map((id) => d.items.find((i) => i.id === id)?.occurredAt ?? "");
    if (times.some((t, k) => k > 0 && t < times[k - 1]) || c.firstAt !== times[0] || c.lastAt !== times.at(-1)) errs.push(`conversation ${c.id} not chronological`);
  }
  for (const id of itemIds) if (!owner.has(id)) errs.push(`item ${id} in no conversation`);
  return errs;
}

if (import.meta.main) {
  const d: Data = await Bun.file(join(import.meta.dir, "data.json")).json();
  const errs = check(d);
  console.log(errs.length ? errs.join("\n") : `ok: ${d.items.length} items, ${d.conversations.length} conversations`);
  process.exit(errs.length ? 1 : 0);
}
