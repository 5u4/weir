// cd design/prototype && bun data/gmail-counts.ts [--check] — tag counts for the Gmail fixtures, written to
// packages/fixtures/expected-tags.json. The rules come from packages/fixtures/config.toml and run through the prototype's
// rule.ts on the fixtures' gws messages, both as fake-gws serves them and trimmed the way the gws plugin stores raw.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { gmailMessages, type GeneratedMessage, type MessagePart } from "../../../packages/fixtures/src/gmail.ts";
import { scenarios } from "../../../packages/fixtures/src/scenarios.ts";
import type { RuleInput } from "./digest";
import { match, Rule } from "./rule";

const FIXTURES = join(import.meta.dir, "../../../packages/fixtures");
const OUT = join(FIXTURES, "expected-tags.json");
const SOURCE = "gmail";
const transport =
  /^(received|arc-|dkim-signature|x-google-|x-gm-|x-received|authentication-results|received-spf|return-path|delivered-to|x-forwarded|feedback-id|x-ses|x-sg-|x-mailgun|x-feedback)/i;
const GMAIL_CONTAINERS: [string, string][] = [
  ["CATEGORY_PROMOTIONS", "Promotions"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_FORUMS", "Forums"],
  ["CATEGORY_PERSONAL", "Primary"],
  ["SENT", "Sent"],
  ["INBOX", "Inbox"],
];

const config = Bun.TOML.parse(readFileSync(join(FIXTURES, "config.toml"), "utf8")) as { tag: { name: string; match: unknown }[] };
const tags = config.tag.map((t) => ({ name: t.name, match: Schema.decodeUnknownSync(Rule)(t.match, { onExcessProperty: "error" }) }));
const me = scenarios.people[scenarios.me].addr.toLowerCase();

const walk = (part: MessagePart, visit: (p: MessagePart) => void) => {
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
};
const trim = (raw: GeneratedMessage): GeneratedMessage => {
  const copy = structuredClone(raw);
  walk(copy.payload, (p) => {
    delete p.body.data;
    p.headers = p.headers.filter((h) => !transport.test(h.name));
  });
  return copy;
};
const header = (m: GeneratedMessage, name: string) => m.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
const plain = (m: GeneratedMessage) => {
  let text = "";
  walk(m.payload, (p) => {
    if (p.mimeType === "text/plain" && p.body.data) text = Buffer.from(p.body.data, "base64url").toString("utf8");
  });
  return text;
};
const input = (m: GeneratedMessage, raw: GeneratedMessage): RuleInput => {
  const from = header(m, "from");
  const parsed = /^(.*?)\s*<([^>]+)>$/.exec(from);
  const address = (parsed?.[2] ?? from).toLowerCase();
  const [containerId, containerName] = GMAIL_CONTAINERS.find(([l]) => m.labelIds.includes(l)) ?? ["INBOX", "Inbox"];
  return {
    source: SOURCE,
    threadId: m.threadId,
    containerId,
    containerName,
    title: header(m, "subject"),
    from: { name: parsed?.[1] ?? "", address },
    fromMe: address === me,
    body: plain(m),
    raw,
  };
};

const messages = gmailMessages(scenarios);
const itemTags = messages.map((m) => {
  const full = tags.filter((t) => match(t.match, input(m, m))).map((t) => t.name);
  const trimmed = tags.filter((t) => match(t.match, input(m, trim(m)))).map((t) => t.name);
  if (full.join() !== trimmed.join()) {
    console.error(`message ${m.id}: tags on the full raw [${full}] differ from the trimmed raw [${trimmed}]`);
    process.exit(1);
  }
  return { threadId: m.threadId, tags: full };
});

const count = (hit: (tags: string[]) => boolean) => {
  const items = itemTags.filter((i) => hit(i.tags));
  return { conversations: new Set(items.map((i) => i.threadId)).size, items: items.length };
};
const threadTags = new Map<string, Set<string>>();
for (const i of itemTags) threadTags.set(i.threadId, new Set([...(threadTags.get(i.threadId) ?? []), ...i.tags]));
const untaggedThreads = [...threadTags].filter(([, t]) => t.size === 0).map(([id]) => id);
const expected = {
  source: SOURCE,
  conversations: threadTags.size,
  items: itemTags.length,
  tags: Object.fromEntries(tags.map((t) => [t.name, count((x) => x.includes(t.name))])),
  untagged: {
    conversations: untaggedThreads.length,
    items: itemTags.filter((i) => untaggedThreads.includes(i.threadId)).length,
  },
};

const json = `${JSON.stringify(expected, null, 2)}\n`;
for (const [name, c] of [...Object.entries(expected.tags), ["Untagged", expected.untagged] as const]) {
  console.log(`${name}: ${c.conversations} conversations, ${c.items} items`);
}
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error(`${OUT} is stale; run bun data/gmail-counts.ts`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, json);
}
