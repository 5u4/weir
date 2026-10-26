// bun data/bakeoff.ts — runs enrich.ts once per candidate into data/runs/<slug>/ and keeps data/runs/index.json current.
import { existsSync } from "node:fs";
import { join } from "node:path";

const RUNS = join(import.meta.dir, "runs");
const BASE = ["omp", "-p", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-extensions", "--no-title"];
const CANDIDATES: { slug: string; label: string; model: string; thinking: string }[] = JSON.parse(process.env.CANDIDATES ?? "[]");

async function writeIndex() {
  const runs = [{ slug: "opus-5.5", label: "opus 5.5 · thinking low (baseline)" }];
  const all: { slug: string; label: string }[] = JSON.parse(process.env.ALL_CANDIDATES ?? process.env.CANDIDATES ?? "[]");
  for (const c of all) if (existsSync(join(RUNS, c.slug, "data.json"))) runs.push({ slug: c.slug, label: c.label });
  await Bun.write(join(RUNS, "index.json"), JSON.stringify({ runs }, null, 1));
}

await writeIndex();
for (const c of CANDIDATES) {
  const t0 = performance.now();
  const proc = Bun.spawn(["bun", join(import.meta.dir, "enrich.ts")], {
    env: { ...process.env, OUT_DIR: join(RUNS, c.slug), WEIR_ENRICH_CMD: JSON.stringify([...BASE, "--model", c.model, "--thinking", c.thinking]) },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  console.log(`== ${c.slug}: exit ${code} in ${Math.round(performance.now() - t0)}ms`);
  await writeIndex();
}
