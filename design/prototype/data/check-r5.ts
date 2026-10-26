// bun data/check-r5.ts — validates runs/gpt-6-luna-r5/data.json: contract invariants, gists, points, synthetic sizes.
import { join } from "node:path";
import * as OpenCC from "opencc-js";
import { check } from "./check";
import type { Data } from "./shared";

const POINT_KINDS: Record<string, true> = { ask: true, decision: true, date: true, info: true };
const toSimplified = OpenCC.Converter({ from: "t", to: "cn" });
const HAN = /\p{Script=Han}/u;

// Returns the gist problem, or null when the gist is usable simplified Chinese.
export function gistProblem(gist: unknown): string | null {
  if (typeof gist !== "string" || !gist.trim()) return "empty";
  if (!HAN.test(gist)) return "no Chinese characters";
  const simplified = toSimplified(gist);
  if (simplified !== gist) return `traditional characters: ${[...gist].filter((ch, k) => ch !== [...simplified][k]).join("")}`;
  return null;
}

export function checkR5(d: Data): string[] {
  const errs = check(d);
  const itemById = new Map(d.items.map((i) => [i.id, i]));
  for (const i of d.items) {
    const problem = gistProblem(i.gist);
    if (problem) errs.push(`item ${i.id} gist ${problem}: ${i.gist}`);
  }
  for (const c of d.conversations) {
    if (!Array.isArray(c.points) || c.points.length > 5) {
      errs.push(`conversation ${c.id} points missing or more than 5`);
      continue;
    }
    for (const p of c.points) {
      if (!POINT_KINDS[p.kind] || typeof p.text !== "string" || !p.text.trim()) errs.push(`conversation ${c.id} bad point ${JSON.stringify(p)}`);
      if (!c.itemIds.includes(p.itemId)) errs.push(`conversation ${c.id} point cites foreign item ${p.itemId}`);
    }
  }
  const expected = [
    { source: "teams", total: [40, 50], unread: [10, 15] },
    { source: "gmail", total: [11, 14], unread: [3, 3] },
  ];
  for (const { source, total, unread } of expected) {
    const conv = d.conversations.find((c) => c.itemIds.every((id) => itemById.get(id)?.synthetic) && itemById.get(c.itemIds[0])?.source === source);
    if (!conv) {
      errs.push(`synthetic ${source} conversation missing`);
      continue;
    }
    const n = conv.itemIds.length;
    const u = conv.itemIds.filter((id) => itemById.get(id)!.occurredAt > d.seenCutoff).length;
    if (n < total[0] || n > total[1] || u < unread[0] || u > unread[1]) errs.push(`synthetic ${source} has ${n} items, ${u} unread`);
  }
  return errs;
}

if (import.meta.main) {
  const d: Data = await Bun.file(join(import.meta.dir, "runs/gpt-6-luna-r5/data.json")).json();
  const errs = checkR5(d);
  console.log(errs.length ? errs.join("\n") : `ok: ${d.items.length} items with simplified-Chinese gists, ${d.conversations.length} conversations with points`);
  process.exit(errs.length ? 1 : 0);
}
