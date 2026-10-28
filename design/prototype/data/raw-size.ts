// bun data/raw-size.ts <dir> — what the gws plugin's trimming saves on a directory of Gmail users.messages.get(format=full) JSON files.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Header = { name: string; value: string };
type Part = { body?: { data?: string }; parts?: Part[]; headers?: Header[] };

const transport =
  /^(received|arc-|dkim-signature|x-google-|x-gm-|x-received|authentication-results|received-spf|return-path|delivered-to|x-forwarded|feedback-id|x-ses|x-sg-|x-mailgun|x-feedback)/i;

const walk = (part: Part, visit: (p: Part) => void) => {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
};

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun data/raw-size.ts <dir of Gmail messages.get format=full JSON files>");
  process.exit(2);
}
const raws = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
let full = 0;
let bodyData = 0;
let withoutBody = 0;
let stripped = 0;
for (const raw of raws) {
  full += size(raw);
  const copy = structuredClone(raw);
  walk(copy.payload, (p) => {
    if (p.body?.data) bodyData += size(p.body.data);
    if (p.body) delete p.body.data;
  });
  withoutBody += size(copy);
  walk(copy.payload, (p) => {
    if (p.headers) p.headers = p.headers.filter((h) => !transport.test(h.name));
  });
  stripped += size(copy);
}

const avg = (n: number) => `${(n / raws.length / 1e3).toFixed(1)} KB`;
const per10k = (n: number) => `${((n / raws.length) * 1e4 / 1e6).toFixed(0)} MB`;
console.log(`messages: ${raws.length}, full raw avg ${avg(full)}, 10k = ${per10k(full)}`);
console.log(`body.data share: ${((bodyData / full) * 100).toFixed(1)}%`);
console.log(`without body.data: avg ${avg(withoutBody)}`);
console.log(`without body.data and transport headers: avg ${avg(stripped)}, 10k = ${per10k(stripped)}`);
