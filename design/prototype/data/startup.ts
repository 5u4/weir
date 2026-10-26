// bun data/startup.ts — splits a trivial omp call into process startup / model round trip / exit,
// using arrival times of the --mode json event stream. Writes data/runs/startup.md.
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = ["omp", "-p", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-extensions", "--no-title"];
const MODELS: [string, string][] = JSON.parse(process.env.MODELS ?? "[]");

async function once(model: string, thinking: string) {
  const t0 = performance.now();
  const proc = Bun.spawn([...BASE, "--model", model, "--thinking", thinking, "--mode", "json"], { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.stdin.write("say ok");
  proc.stdin.end();
  let first = 0, turnStart = 0, end = 0, buf = "", error = "";
  const dec = new TextDecoder();
  for await (const chunk of proc.stdout) {
    const now = performance.now() - t0;
    buf += dec.decode(chunk);
    if (!first) first = now;
    if (!turnStart && buf.includes('"type":"turn_start"')) turnStart = now;
    if (!end && buf.includes('"type":"agent_end"')) end = now;
  }
  await proc.exited;
  const exit = performance.now() - t0;
  error = buf.match(/"errorMessage":"([^"]{0,80})/)?.[1] ?? "";
  return { startup: Math.round(turnStart || first), model: Math.round(end - (turnStart || first)), exit: Math.round(exit - end), total: Math.round(exit), error };
}

const rows: string[] = [];
for (const [model, thinking] of MODELS) {
  const rs = [];
  for (let k = 0; k < 3; k++) rs.push(await once(model, thinking));
  const avg = (f: (r: (typeof rs)[number]) => number) => Math.round(rs.reduce((n, r) => n + f(r), 0) / rs.length);
  rows.push(`| ${model} | ${thinking} | ${rs.map((r) => r.total).join(" / ")} | ${avg((r) => r.startup)} | ${avg((r) => r.model)} | ${avg((r) => r.exit)} | ${avg((r) => r.total)} | ${rs.map((r) => r.error).filter(Boolean).join("; ") || "-"} |`);
  console.log(rows.at(-1));
}
await Bun.write(
  join(import.meta.dir, "runs/startup.md"),
  `# omp per-call overhead (trivial "say ok", 3 calls each, sequential)

Measured ${new Date().toISOString()}. startup = spawn → first \`turn_start\` event on stdout; model = \`turn_start\` → \`agent_end\` (request + inference + streaming); exit = \`agent_end\` → process exit.

| model | thinking | total ms (3 calls) | avg startup | avg model | avg exit | avg total | errors |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`,
);
