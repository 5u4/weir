import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { tag: { type: "string" }, sha: { type: "string" } } });
const { tag, sha } = values;
if (tag === undefined || sha === undefined) {
  console.error("usage: bun scripts/release-check.ts --tag <vX.Y.Z> --sha <commit>");
  process.exit(1);
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`release-check: tag ${tag} is not v<major>.<minor>.<patch>`);
  process.exit(1);
}

const root = `${import.meta.dirname}/..`;
const run = (cmd: string[]) =>
  Bun.spawnSync({ cmd, cwd: root, stdio: ["ignore", "inherit", "inherit"] }).exitCode;

if (run(["git", "fetch", "--no-tags", "origin", "main"]) !== 0) {
  console.error("release-check: git fetch origin main failed");
  process.exit(1);
}
if (run(["git", "merge-base", "--is-ancestor", sha, "FETCH_HEAD"]) !== 0) {
  console.error(`release-check: ${sha} is not on origin/main`);
  process.exit(1);
}
for (const step of ["typecheck", "lint", "test"]) {
  if (run(["bun", "run", step]) !== 0) {
    console.error(`release-check: ${step} failed`);
    process.exit(1);
  }
}
console.log(tag.slice(1));
