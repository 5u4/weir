// cd design/prototype && bun data/gmail-counts.ts [--check] — tag counts for the Gmail fixtures, written to
// packages/fixtures/expected-tags.json. The rules come from packages/fixtures/config.toml and run through the prototype's
// rule.ts on the fixtures' gws messages, both as fake-gws serves them and trimmed the way the gws plugin stores raw.
// A conversation is a thread, or every thread with an item matching the same [[group]].
// --check also syncs the real gws plugin against fake-gws and requires its RawItems to give the same counts.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { gmailMessages, type GeneratedMessage, type MessagePart } from "../../../packages/fixtures/src/gmail.ts";
import { scenarios } from "../../../packages/fixtures/src/scenarios.ts";
import { gws } from "../../../plugins/gws/src/index.ts";
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

type Matcher = { name: string; match: unknown };
const config = Bun.TOML.parse(readFileSync(join(FIXTURES, "config.toml"), "utf8")) as { tag: Matcher[]; group?: Matcher[] };
const decodeRules = (entries: Matcher[]) => entries.map((t) => ({ name: t.name, match: Schema.decodeUnknownSync(Rule)(t.match, { onExcessProperty: "error" }) }));
const tags = decodeRules(config.tag);
const groups = decodeRules(config.group ?? []);
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
  return { threadId: m.threadId, tags: full, groups: groups.filter((g) => match(g.match, input(m, m))).map((g) => g.name) };
});

type ItemTags = { threadId: string; tags: string[]; groups: string[] };
const summarize = (threadItems: ItemTags[]) => {
  const keyOf = new Map<string, string>();
  for (const { threadId } of threadItems) {
    const matched = new Set(threadItems.filter((i) => i.threadId === threadId).flatMap((i) => i.groups));
    const group = groups.find((g) => matched.has(g.name));
    keyOf.set(threadId, group === undefined ? threadId : `group:${group.name}`);
  }
  const itemTags = threadItems.map((i) => ({ key: keyOf.get(i.threadId) ?? i.threadId, tags: i.tags }));
  const count = (hit: (tags: string[]) => boolean) => {
    const conversationTags = new Map<string, boolean>();
    for (const i of itemTags) conversationTags.set(i.key, (conversationTags.get(i.key) ?? false) || hit(i.tags));
    const items = itemTags.filter((i) => hit(i.tags));
    return { conversations: [...conversationTags.values()].filter(Boolean).length, items: items.length };
  };
  const keyTags = new Map<string, Set<string>>();
  for (const i of itemTags) keyTags.set(i.key, new Set([...(keyTags.get(i.key) ?? []), ...i.tags]));
  const untaggedKeys = [...keyTags].filter(([, t]) => t.size === 0).map(([id]) => id);
  return {
    source: SOURCE,
    conversations: keyTags.size,
    items: itemTags.length,
    tags: Object.fromEntries(tags.map((t) => [t.name, count((x) => x.includes(t.name))])),
    untagged: {
      conversations: untaggedKeys.length,
      items: itemTags.filter((i) => untaggedKeys.includes(i.key)).length,
    },
  };
};

const pluginItemTags = async (): Promise<ItemTags[]> => {
  const source = gws.create({ command: [join(import.meta.dir, "../../../node_modules/.bin/fake-gws")], backfill: "newer_than:30d", labels: ["INBOX", "SENT", "CATEGORY_PROMOTIONS"] });
  const [stream] = await source.streams();
  if (!stream) throw new Error("gws plugin returned no stream");
  const result = new Map<string, ItemTags>();
  let cursor: string | null = null;
  for (;;) {
    const page = await source.sync(stream.id, cursor, new AbortController().signal);
    for (const i of page.upserts) {
      const input: RuleInput = {
        source: SOURCE,
        threadId: i.threadId,
        containerId: i.containerId,
        containerName: i.containerName,
        title: i.title ?? "",
        from: i.from,
        fromMe: stream.me.includes(i.from.address),
        body: i.body,
        raw: i.raw,
      };
      result.set(i.externalId, {
        threadId: i.threadId ?? i.containerId,
        tags: tags.filter((t) => match(t.match, input)).map((t) => t.name),
        groups: groups.filter((g) => match(g.match, input)).map((g) => g.name),
      });
    }
    cursor = page.cursor;
    if (!page.more) return [...result.values()];
  }
};

const expected = summarize(itemTags);
const json = `${JSON.stringify(expected, null, 2)}\n`;
for (const [name, c] of [...Object.entries(expected.tags), ["Untagged", expected.untagged] as const]) {
  console.log(`${name}: ${c.conversations} conversations, ${c.items} items`);
}
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error(`${OUT} is stale; run bun data/gmail-counts.ts`);
    process.exit(1);
  }
  const plugin = `${JSON.stringify(summarize(await pluginItemTags()), null, 2)}\n`;
  if (plugin !== json) {
    console.error(`gws plugin RawItems against fake-gws give different counts than ${OUT}:\n${plugin}`);
    process.exit(1);
  }
  console.log("gws plugin RawItems against fake-gws match expected-tags.json");
} else {
  writeFileSync(OUT, json);
}
