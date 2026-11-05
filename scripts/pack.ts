import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { version: { type: "string" } } });
const version = values.version;
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run pack --version <x.y.z>");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const run = (cmd: string[], cwd = root) => {
  const { exitCode } = Bun.spawnSync({ cmd, cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (exitCode !== 0) throw new Error(`${cmd.join(" ")} exited ${exitCode}`);
};

const stage = mkdtempSync(join(tmpdir(), "weir-pack-"));
try {
  run(["bun", "run", "build:web"]);
  for (const [entry, name] of [
    ["apps/cli/src/main.ts", "cli"],
    ["apps/daemon/src/main.ts", "daemon"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, entry)],
      outdir: stage,
      naming: `${name}.js`,
      target: "bun",
      define: { WEIR_VERSION: JSON.stringify(version) },
    });
    if (!result.success) throw new AggregateError(result.logs, `bundling ${entry} failed`);
  }
  cpSync(join(root, "apps/web/dist"), join(stage, "web"), { recursive: true });
  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify({ name: "weir", version, bin: { weir: "cli.js" } }, null, 2)}\n`,
  );
  run(["bun", "pm", "pack", "--filename", join(root, "weir.tgz")], stage);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
