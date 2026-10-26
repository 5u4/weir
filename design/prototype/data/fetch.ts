// WINDOW_DAYS=10 CUTOFF_HOURS=72 bun data/fetch.ts — pulls the last WINDOW_DAYS of Gmail into data/raw/
// (cached per message id), normalizes to contract Items, sets seenCutoff = now - CUTOFF_HOURS,
// writes data/fetched.json (enrich input) and a pre-enrich data/data.json.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import bucketDefs from "./prompts/buckets.toml";
import { pool, type Addr, type Conversation, type Data, type Item } from "./shared";

type GmailPart = {
  mimeType: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate: string; payload: GmailPart };

const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 10);
const CUTOFF_HOURS = Number(process.env.CUTOFF_HOURS ?? 72);
const QUERY = `newer_than:${WINDOW_DAYS}d -in:spam -in:trash -in:drafts`;
const CONCURRENCY = 8;
const BODY_NEW_CAP = 6000;

const DIR = import.meta.dir;
const RAW = join(DIR, "raw");
mkdirSync(RAW, { recursive: true });

// Gmail API responses are trusted as-is in this throwaway prototype; no schema validation.
async function gws<T>(...args: string[]): Promise<T> {
  const proc = Bun.spawn(["gws", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // gws prints "Using keyring backend: keyring" before the JSON.
  const start = out.search(/^[{[]/m);
  if (code !== 0 || start < 0) throw new Error(`gws ${args.join(" ")} failed (${code}): ${err}${out}`.slice(0, 2000));
  return JSON.parse(out.slice(start)) as T;
}
const params = (p: object) => ["--params", JSON.stringify(p)];

const profile = await gws<{ emailAddress: string }>("gmail", "users", "getProfile", ...params({ userId: "me" }));
const me = [profile.emailAddress.toLowerCase()];
const labelList = await gws<{ labels: { id: string; name: string }[] }>("gmail", "users", "labels", "list", ...params({ userId: "me" }));
const labelNames = new Map(labelList.labels.map((l) => [l.id, l.name]));

const ids: string[] = [];
let pageToken: string | undefined;
do {
  const page = await gws<{ messages?: { id: string }[]; nextPageToken?: string }>(
    "gmail", "users", "messages", "list", ...params({ userId: "me", q: QUERY, maxResults: 500, pageToken }),
  );
  for (const m of page.messages ?? []) ids.push(m.id);
  pageToken = page.nextPageToken;
} while (pageToken);

let fetchedNow = 0;
const raws = await pool(ids, CONCURRENCY, async (id): Promise<GmailMessage> => {
  const file = join(RAW, `${id}.json`);
  if (existsSync(file)) return Bun.file(file).json();
  const msg = await gws<GmailMessage>("gmail", "users", "messages", "get", ...params({ userId: "me", id, format: "full" }));
  await Bun.write(file, JSON.stringify(msg));
  fetchedNow++;
  return msg;
});
console.log(`listed ${ids.length} messages, fetched ${fetchedNow} new, ${ids.length - fetchedNow} cached`);

// ---- normalize ----

function findPart(p: GmailPart, mime: string): string | null {
  if (p.mimeType === mime && p.body?.data && !p.filename)
    return Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  for (const c of p.parts ?? []) {
    const r = findPart(c, mime);
    if (r) return r;
  }
  return null;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", zwnj: "", zwj: "", shy: "" };
function htmlToText(html: string): string {
  let s = html
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    // Gmail/Outlook wrap quoted history in these; mark the spot so splitBody can cut there.
    .replace(/<(div|blockquote)[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>/gi, "\n\n<<QUOTE>>\n")
    .replace(/<div[^>]*id="(divRplyFwdMsg|appendonsend)"[^>]*>/gi, "\n\n<<QUOTE>>\n")
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "").trim();
      // Tracking URLs are long noise; keep short ones so links survive as text.
      if (!href.startsWith("http") || href.length > 100 || text === href) return text;
      return text ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s
    .split("\n")
    .map((l) => l.replace(/[\s\u200b\u034f\u00ad]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitBody(text: string): { bodyNew: string; bodyQuoted: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length && cut === lines.length; i++) {
    const l = lines[i];
    const two = `${l} ${lines[i + 1] ?? ""}`;
    if (
      l === "<<QUOTE>>" ||
      /^-- ?$/.test(l) ||
      /^On .{0,300}wrote:\s*$/.test(l) ||
      (/^On .{0,300}$/.test(l) && /^\S.{0,200}wrote:\s*$/.test(lines[i + 1] ?? "") && /^On .{0,400}wrote:\s*$/.test(two)) ||
      /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l) ||
      /^_{10,}\s*$/.test(l) ||
      (/^\*?From:\*?\s/.test(l) && lines.slice(i + 1, i + 5).some((n) => /^\*?(Sent|Date):\*?\s/.test(n))) ||
      (/^>/.test(l) && (lines[i + 1] ?? ">").startsWith(">"))
    )
      cut = i;
  }
  const clean = (ls: string[]) => ls.filter((l) => l !== "<<QUOTE>>").join("\n").trim();
  let bodyNew = clean(lines.slice(0, cut));
  if (bodyNew.length > BODY_NEW_CAP) bodyNew = `${bodyNew.slice(0, BODY_NEW_CAP)}…`;
  return { bodyNew, bodyQuoted: clean(lines.slice(cut)) };
}

function parseAddrs(v: string | undefined): Addr[] {
  if (!v) return [];
  // Split on commas outside quotes and angle brackets.
  const parts: string[] = [];
  let cur = "", q = false, a = false;
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (ch === "<") a = true;
    if (ch === ">") a = false;
    if (ch === "," && !q && !a) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(.*?)\s*<([^>]+)>$/);
      if (m) return { name: m[1].replace(/^"|"$/g, "").trim(), addr: m[2].trim().toLowerCase() };
      return { name: "", addr: p.toLowerCase() };
    });
}

const LABEL_PRIORITY = ["SENT", "CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "INBOX", "CATEGORY_PERSONAL"];
const LABEL_SHORT: Record<string, string> = {
  SENT: "Sent", INBOX: "Inbox", CATEGORY_UPDATES: "Updates", CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_SOCIAL: "Social", CATEGORY_FORUMS: "Forums", CATEGORY_PERSONAL: "Primary",
};
function container(labelIds: string[]): string {
  for (const l of LABEL_PRIORITY) if (labelIds.includes(l)) return l;
  return labelIds.find((l) => l.startsWith("Label_")) ?? labelIds.find((l) => !["UNREAD", "IMPORTANT", "STARRED"].includes(l)) ?? "ARCHIVE";
}
const items: Item[] = raws.map((m) => {
  const h = new Map((m.payload.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
  const plain = findPart(m.payload, "text/plain");
  const html = plain ? null : findPart(m.payload, "text/html");
  const text = plain ?? (html ? htmlToText(html) : m.snippet ?? "");
  const labels = m.labelIds ?? [];
  const containerId = container(labels);
  return {
    id: m.id,
    source: "gmail",
    sourceLabel: `Gmail · ${LABEL_SHORT[containerId] ?? labelNames.get(containerId) ?? containerId}`,
    threadId: m.threadId,
    containerId,
    from: parseAddrs(h.get("from"))[0] ?? { name: "", addr: "" },
    to: parseAddrs(h.get("to")),
    cc: parseAddrs(h.get("cc")),
    subject: h.get("subject") ?? "(no subject)",
    occurredAt: new Date(Number(m.internalDate)).toISOString(),
    ...splitBody(text),
    link: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
  };
});
items.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

const generatedAt = new Date();
const seenCutoff = new Date(generatedAt.getTime() - CUTOFF_HOURS * 3600_000).toISOString();
const buckets = Object.entries(bucketDefs as Record<string, { name: string }>).map(([id, b]) => ({ id, name: b.name }));

const byThread = Map.groupBy(items, (i) => i.threadId ?? i.id);
const conversations: Conversation[] = [...byThread].map(([threadId, its]) => ({
  id: `c-${threadId}`,
  title: its[0].subject,
  bucket: null,
  summary: "",
  update: null,
  itemIds: its.map((i) => i.id),
  threadIds: [threadId],
  mergeReason: null,
  firstAt: its[0].occurredAt,
  lastAt: its.at(-1)!.occurredAt,
}));
conversations.sort((a, b) => b.lastAt.localeCompare(a.lastAt));

const data: Data = { generatedAt: generatedAt.toISOString(), me, seenCutoff, buckets, items, conversations, enrichRuns: [] };
// windowDays is outside the contract; it rides along in fetched.json only so enrich can report it.
await Bun.write(join(DIR, "fetched.json"), JSON.stringify({ ...data, windowDays: WINDOW_DAYS }, null, 1));
await Bun.write(join(DIR, "data.json"), JSON.stringify(data, null, 1));
console.log(`wrote ${items.length} items, ${conversations.length} threads; window ${WINDOW_DAYS}d, seenCutoff ${seenCutoff} (${CUTOFF_HOURS}h)`);
