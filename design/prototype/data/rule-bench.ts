// bun data/rule-bench.ts [dir | file.json] — times tags.toml over rule inputs. Default: every item expanded from
// scenarios.json. A directory of Gmail users.messages.get JSON files, or one JSON file holding one such message or an
// array of them, is matched as Gmail mail not from me.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expand, loadConfig, ruleInput, type RuleInput } from "./digest";
import { match } from "./rule";

const arg = process.argv[2];
let t = performance.now();
let inputs: RuleInput[];
let what: string;
if (arg) {
  const files = statSync(arg).isDirectory() ? readdirSync(arg).filter((f) => f.endsWith(".json")).map((f) => join(arg, f)) : [arg];
  const raws = files.flatMap((f) => JSON.parse(readFileSync(f, "utf8")));
  const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
  inputs = raws.map((raw) => ({ source: "gmail", threadId: null, containerId: "", containerName: "", title: "", from: { name: "", address: "" }, fromMe: false, body: "", raw }));
  what = `${raws.length} raw Gmail messages from ${arg}, ${(bytes / 1e6).toFixed(1)} MB`;
} else {
  const { list, me } = expand();
  inputs = list.map((s) => ruleInput(s, me.addrs.includes(s.from.addr.toLowerCase())));
  what = `${inputs.length} items expanded from scenarios.json`;
}
const loadMs = performance.now() - t;

const tags = loadConfig().tag ?? [];
t = performance.now();
const hits: Record<string, number> = Object.fromEntries(tags.map((tag) => [tag.name, 0]));
for (const input of inputs) for (const tag of tags) if (match(tag.match, input)) hits[tag.name]++;
const matchMs = performance.now() - t;

console.log(what);
console.log(`load: ${loadMs.toFixed(1)} ms`);
console.log(`${tags.length} tags x ${inputs.length} items matched in ${matchMs.toFixed(1)} ms; item hits ${JSON.stringify(hits)}`);
