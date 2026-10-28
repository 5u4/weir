// bun data/digest.ts [--structure] — builds data/out from scenarios.json and tags.toml: scenarios expanded into
// plugin-shaped records, structural conversations, tags from rules, then the auto chain in AI-enabled conversations.
// ux/serve.ts imports the range functions and generate() for POST /__digest and /__sim.
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeConfig, match, type Config } from "./rule";

const RANGE_ITEM_CHARS = 6000;
const CONCURRENCY = 6;
const CALL_TIMEOUT_MS = 5 * 60_000;
const CMD: string[] = process.env.WEIR_ENRICH_CMD
  ? JSON.parse(process.env.WEIR_ENRICH_CMD)
  : ["omp", "-p", "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-extensions", "--no-title", "--model", "gpt-6-luna", "--thinking", "low"];
const MODEL = CMD.includes("--model") ? CMD[CMD.indexOf("--model") + 1] : "custom WEIR_ENRICH_CMD";

const DIR = import.meta.dir;
const OUT_DIR = join(DIR, "out");
const TEMPLATE = readFileSync(join(DIR, "prompts/digest-topics.md"), "utf8");
const TENANT = "7d1e4c90-2b6a-4f1d-8e3c-5a9b0c1d2e3f";

export type Addr = { name: string; addr: string };
export type Item = {
  id: string;
  source: "gmail" | "teams";
  sourceLabel: string;
  threadId: string | null;
  containerId: string;
  containerName: string;
  title: string;
  from: Addr;
  occurredAt: string;
  bodyNew: string;
  bodyQuoted: string;
  link: string;
  conversationId: string;
  seq: number;
  fromMe: boolean;
};
export type Conv = {
  id: string;
  source: "gmail" | "teams";
  kind: "email" | "chat" | "dm" | "channel";
  title: string;
  itemIds: string[];
  lastSeq: number;
  seenSeq: number;
  tags: string[];
  since: string | null;
  firstAt: string;
  lastAt: string;
};
export type Topic = { title: string; state: "open" | "resolved" | "fyi"; body: string; seqs: number[] };
export type Digest = {
  id: string;
  conversationId: string;
  fromSeq: number;
  toSeq: number;
  trigger: "auto" | "manual";
  headline: string;
  topics: Topic[];
  contextChars: number;
  inputChars: number;
  ms: number;
  model: string;
  createdAt: string;
};
export type TagInfo = { name: string; ai: boolean; aiSince: string | null };
export type Data = {
  generatedAt: string;
  seenCutoff: string;
  me: { addrs: string[]; names: string[] };
  digest: { threshold: number; maxInput: number; context: number };
  tags: TagInfo[];
  sources: { id: "gmail" | "teams"; name: string }[];
  items: Item[];
  conversations: Conv[];
  digests: Digest[];
};
export type CallLog = { conversationId: string; fromSeq: number; toSeq: number; trigger: Digest["trigger"]; attempts: number; ok: boolean; error?: string; ms: number; inputChars: number; outputChars: number; contextChars: number };
export type RuleInput = { source: string; threadId: string | null; containerId: string; containerName: string; title: string; from: { name: string; address: string }; fromMe: boolean; body: string; raw: unknown };

export const loadConfig = (): Config => decodeConfig(readFileSync(join(DIR, "tags.toml"), "utf8"));

export const tagsOfInput = (config: Config, input: RuleInput): string[] => (config.tag ?? []).filter((t) => match(t.match, input)).map((t) => t.name);

// Earliest ai_since among the conversation's ai = true tags; null when no tag turns AI on.
export function sinceOf(config: Config, tags: string[]): string | null {
  const at = (config.tag ?? []).filter((t) => t.ai && tags.includes(t.name)).map((t) => config.tag_state?.[t.name]).filter((s): s is string => !!s);
  return at.length ? at.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}

export const floorOf = (digests: Pick<Digest, "toSeq">[]) => Math.max(0, ...digests.map((d) => d.toSeq));

export function autoRange(items: Item[], digests: Pick<Digest, "toSeq">[], since: string | null, threshold: number): [number, number] | null {
  if (!since || !items.length) return null;
  const floor = floorOf(digests);
  const start = items.find((i) => i.seq > floor && Date.parse(i.occurredAt) >= Date.parse(since));
  if (!start) return null;
  return items.filter((i) => i.seq >= start.seq).reduce((n, i) => n + i.bodyNew.length, 0) >= threshold ? [start.seq, items.at(-1)!.seq] : null;
}

export type ManualReq = { fromSeq?: number; upTo?: number; whole?: boolean; redo?: { fromSeq: number; toSeq: number } };
/* Digest now: (floor, last]. Digest from here: [fromSeq, next digest's fromSeq - 1]. Digest earlier: up to upTo, from the
   previous digest's toSeq + 1 when whole, else as far back as one model call takes (maxInput chars of bodyNew, at least
   one message). Redo: an existing digest's exact range. */
export function manualRange(items: Item[], digests: Pick<Digest, "fromSeq" | "toSeq">[], req: ManualReq, maxInput: number): [number, number] | string {
  const last = items.at(-1)?.seq ?? 0;
  if (req.redo) {
    const { fromSeq, toSeq } = req.redo;
    return digests.some((d) => d.fromSeq === fromSeq && d.toSeq === toSeq) ? [fromSeq, toSeq] : `no digest covers exactly #${fromSeq}-#${toSeq}`;
  }
  const loose = (q: number) => (!(q >= 1 && q <= last) ? `#${q} is outside #1-#${last}` : digests.some((d) => d.fromSeq <= q && q <= d.toSeq) ? `#${q} is already in a digest` : null);
  if (req.fromSeq != null) {
    const q = req.fromSeq;
    const next = Math.min(last + 1, ...digests.filter((d) => d.fromSeq > q).map((d) => d.fromSeq));
    return loose(q) ?? [q, next - 1];
  }
  if (req.upTo != null) {
    const q = req.upTo;
    const bad = loose(q);
    if (bad) return bad;
    const floor = floorOf(digests.filter((d) => d.toSeq < q));
    if (req.whole) return [floor + 1, q];
    let from = q;
    let n = items[from - 1].bodyNew.length;
    while (from - 1 > floor && n + items[from - 2].bodyNew.length <= maxInput) n += items[--from - 1].bodyNew.length;
    return [from, q];
  }
  const floor = floorOf(digests);
  return floor < last ? [floor + 1, last] : "nothing after the last digest";
}

export const overlaps = (digests: Pick<Digest, "fromSeq" | "toSeq">[], a: number, b: number) => digests.some((d) => d.fromSeq <= b && a <= d.toSeq);

// Consecutive chunks of at most max chars of bodyNew; an item longer than max is a chunk of its own.
export function chunks(range: Item[], max: number): [number, number][] {
  const out: [number, number][] = [];
  let from = -1;
  let n = 0;
  for (const i of range) {
    if (from >= 0 && n + i.bodyNew.length > max) {
      out.push([from, i.seq - 1]);
      from = -1;
      n = 0;
    }
    if (from < 0) from = i.seq;
    n += i.bodyNew.length;
  }
  if (from >= 0) out.push([from, range.at(-1)!.seq]);
  return out;
}

const hanCount = (s: string) => (s.match(/\p{Script=Han}/gu) ?? []).length;

function renderItem(i: Item, speakerId?: string) {
  const who = `${speakerId ? `[${speakerId}] ` : ""}${i.from.name || i.from.addr}${i.fromMe ? " (你)" : ""}`;
  const head = i.source === "gmail" ? `${who}\nsubject: ${i.title}` : who;
  const body = i.bodyNew.length > RANGE_ITEM_CHARS ? `${i.bodyNew.slice(0, RANGE_ITEM_CHARS)}…[truncated]` : i.bodyNew;
  return `#${i.seq} ${i.occurredAt} ${head}\n${body.replaceAll(/<<<|>>>/g, "")}`;
}

function renderDigest(d: Digest) {
  return `[earlier digest of #${d.fromSeq}-#${d.toSeq}] ${d.headline}\n${d.topics.map((t) => `- ${t.title} (${t.state}): ${t.body}`).join("\n")}`;
}

// Walk back from fromSeq-1: an item inside a digest is replaced by that digest once; uncovered items go in raw.
function buildContext(items: Item[], digests: Digest[], fromSeq: number, budget: number) {
  const pieces: string[] = [];
  let used = 0;
  for (let seq = fromSeq - 1; seq >= 1 && used < budget; ) {
    const d = digests.find((x) => x.fromSeq <= seq && seq <= x.toSeq);
    const text = d ? renderDigest(d) : renderItem(items[seq - 1]);
    const piece = used + text.length > budget ? `${text.slice(0, budget - used)}…` : text;
    pieces.unshift(piece);
    used += piece.length;
    seq = d ? d.fromSeq - 1 : seq - 1;
  }
  return pieces.join("\n\n");
}

const STATES: Record<string, true> = { open: true, resolved: true, fyi: true };
const obj = (x: unknown) => (typeof x === "object" && x !== null ? x : {}) as Record<string, unknown>;

function parseDigestOut(out: unknown, range: Item[]): Pick<Digest, "headline" | "topics"> {
  const fromSeq = range[0].seq;
  const toSeq = range.at(-1)!.seq;
  const { headline, topics } = obj(out);
  if (typeof headline !== "string" || !headline.trim()) throw new Error("missing headline");
  if (hanCount(headline) > 40 || headline.length > 70) throw new Error(`headline too long (${hanCount(headline)} han)`);
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 4) throw new Error(`expected 1-4 topics, got ${Array.isArray(topics) ? topics.length : typeof topics}`);
  if (range.length === 1 && topics.length !== 1) throw new Error(`a single message is exactly one topic, got ${topics.length}`);
  const citedBy = new Map<number, number>();
  const outTopics = topics.map((t: unknown, k): Topic => {
    const { title, state, body, seqs } = obj(t);
    if (typeof title !== "string" || !title.trim()) throw new Error(`topic ${k} missing title`);
    if (hanCount(title) > 16 || title.length > 40) throw new Error(`topic ${k} title too long (${hanCount(title)} han)`);
    if (!STATES[state as string]) throw new Error(`topic ${k} bad state ${String(state)}`);
    if (typeof body !== "string" || !body.trim()) throw new Error(`topic ${k} empty body`);
    if (hanCount(body) > 80 || body.length > 160) throw new Error(`topic ${k} body too long (${hanCount(body)} han)`);
    if (!Array.isArray(seqs) || !seqs.length || !seqs.every((s) => Number.isInteger(s) && s >= fromSeq && s <= toSeq)) throw new Error(`topic ${k} seqs ${JSON.stringify(seqs)} outside ${fromSeq}-${toSeq}`);
    const sorted = [...new Set(seqs as number[])].sort((a, b) => a - b);
    for (const s of sorted) {
      if (citedBy.has(s)) throw new Error(`#${s} is in both topic ${citedBy.get(s)} and topic ${k}; each message belongs to at most one topic`);
      citedBy.set(s, k);
    }
    return { title: title.trim(), state: state as Topic["state"], body: body.trim(), seqs: sorted };
  });
  return { headline: headline.trim(), topics: outTopics };
}

async function call(args: { conv: Conv; items: Item[]; digests: Digest[]; me: Data["me"]; fromSeq: number; toSeq: number; trigger: Digest["trigger"]; context: number; logPrefix: string }): Promise<{ digest: Digest | null; log: CallLog }> {
  const { conv, items, me, fromSeq, toSeq, trigger } = args;
  const context = buildContext(items, args.digests.filter((d) => d.toSeq < fromSeq), fromSeq, args.context);
  const range = items.slice(fromSeq - 1, toSeq);
  const idByAddr = new Map<string, string>();
  for (const i of range) if (!idByAddr.has(i.from.addr)) idByAddr.set(i.from.addr, `p${idByAddr.size + 1}`);
  const prompt = TEMPLATE.replace("{{ME}}", () => `${me.names.join(", ")} <${me.addrs.join(", ")}>`)
    .replace("{{CONVERSATION}}", () => `${conv.kind} "${conv.title}" (${items[0].sourceLabel}), messages #1-#${items.length}; this digest covers #${fromSeq}-#${toSeq} (${range.length} message${range.length === 1 ? "" : "s"})`)
    .replace("{{CONTEXT}}", () => context || "(none: the range starts at the beginning of the conversation)")
    .replace("{{RANGE}}", () => range.map((i) => renderItem(i, idByAddr.get(i.from.addr))).join("\n\n"));
  mkdirSync(join(OUT_DIR, "logs"), { recursive: true });
  const t0 = performance.now();
  let outputChars = 0;
  let error: string | undefined;
  for (const attempt of [1, 2, 3]) {
    const ta = performance.now();
    const sent = error
      ? `${prompt}\n\nYour previous answer was rejected by the validator (${error}). Answer again within every limit above: headline at most 40 Chinese characters, topic titles at most 16, topic bodies at most 80 (cut detail, keep who and where it stands); 1-4 topics (merge beyond 4, exactly one for a single message); every seq in at most one topic.`
      : prompt;
    const proc = Bun.spawn(CMD, { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: CALL_TIMEOUT_MS });
    proc.stdin.write(sent);
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    outputChars = stdout.length;
    let parsed: Pick<Digest, "headline" | "topics"> | undefined;
    try {
      if (code !== 0) throw new Error(`exit ${code}`);
      parsed = parseDigestOut(lastJson(stdout), range);
      error = undefined;
    } catch (e) {
      error = `attempt ${attempt}: ${e instanceof Error ? e.message : String(e)}`;
    }
    await Bun.write(
      join(OUT_DIR, "logs", `${args.logPrefix}${conv.id.replace(/[^\w.-]+/g, "_")}-${fromSeq}-${toSeq}-${trigger}${attempt > 1 ? `-retry${attempt - 1}` : ""}.txt`),
      `cmd: ${JSON.stringify(CMD)} (prompt via stdin)\nexit: ${code}  ms: ${Math.round(performance.now() - ta)}  ${error ?? "ok"}\n\n===== PROMPT =====\n${sent}\n\n===== STDOUT =====\n${stdout}\n\n===== STDERR =====\n${stderr}`,
    );
    if (parsed) {
      const ms = Math.round(performance.now() - t0);
      return {
        digest: { id: `d-${conv.id}-${fromSeq}-${toSeq}-${Date.now().toString(36)}`, conversationId: conv.id, fromSeq, toSeq, trigger, ...parsed, contextChars: context.length, inputChars: prompt.length, ms, model: MODEL, createdAt: new Date().toISOString() },
        log: { conversationId: conv.id, fromSeq, toSeq, trigger, attempts: attempt, ok: true, ms, inputChars: prompt.length, outputChars, contextChars: context.length },
      };
    }
  }
  return { digest: null, log: { conversationId: conv.id, fromSeq, toSeq, trigger, attempts: 3, ok: false, error, ms: Math.round(performance.now() - t0), inputChars: prompt.length, outputChars, contextChars: context.length } };
}

// One range, cut into chunks generated in order; each chunk sees the digests before it, the previous chunk included.
export async function generate(args: { conv: Conv; items: Item[]; digests: Digest[]; data: Data; fromSeq: number; toSeq: number; trigger: Digest["trigger"]; logPrefix: string }) {
  const { conv, items, data, fromSeq, toSeq, trigger } = args;
  const made: Digest[] = [];
  const logs: CallLog[] = [];
  for (const [a, b] of chunks(items.slice(fromSeq - 1, toSeq), data.digest.maxInput)) {
    const before = [...args.digests, ...made];
    const { digest, log } = await call({ conv, items, digests: before, me: data.me, fromSeq: a, toSeq: b, trigger, context: data.digest.context, logPrefix: args.logPrefix });
    logs.push(log);
    if (!digest) break;
    made.push(digest);
  }
  return { made, logs };
}

export const readData = async (): Promise<Data> => Bun.file(join(OUT_DIR, "data.json")).json();
export async function writeData(data: Data) {
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = join(OUT_DIR, `data.json.${process.pid}.tmp`);
  await Bun.write(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, join(OUT_DIR, "data.json"));
}
export const itemsOfConv = (data: Data, id: string) => data.items.filter((i) => i.conversationId === id).sort((a, b) => a.seq - b.seq);

function lastJson(s: string): unknown {
  for (const m of [...s.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)].reverse()) {
    try {
      return JSON.parse(m[1]);
    } catch {}
  }
  const end = s.lastIndexOf("}");
  for (let i = s.lastIndexOf("{", end); i >= 0; i = s.lastIndexOf("{", i - 1)) {
    try {
      return JSON.parse(s.slice(i, end + 1));
    } catch {}
  }
  throw new Error("no JSON block in output");
}

async function pool<T>(xs: T[], n: number, fn: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) await fn(xs[next++]);
    }),
  );
}

// ---- scenarios.json expanded into what plugins would hand over: normalized fields plus the source-native object in raw ----

type Person = { name: string; addr: string; bot?: true; signature?: string };
type Chat = { id: string; kind: "chat" | "dm" | "channel"; title: string; members: string[]; messages: { at: string; from: string; text: string; post?: string }[] };
type Thread = { id: string; subject: string; labels: string[]; headers?: Record<string, string>; messages: { at: string; from: string; to: string[]; cc?: string[]; text: string }[] };
type Scenarios = { seenCutoff: string; me: string; people: Record<string, Person>; chats: Chat[]; threads: Thread[] };
export type Source = Omit<Item, "conversationId" | "seq" | "fromMe"> & { raw: unknown; kind?: Chat["kind"] };

const sha1 = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");
const guid = (s: string) => {
  const h = sha1(s);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// A Microsoft Graph chatMessage; "@Name" or "@First" of a chat member becomes an <at> mention.
export function graphMessage(m: { id: string; at: string; text: string; sender: Person; replyToId: string | null; chatId: string; channel: boolean }, members: Person[]) {
  const mentions: unknown[] = [];
  const names = members.filter((p) => !p.bot).flatMap((p) => [[p.name, p] as const, [p.name.split(" ")[0], p] as const]).sort((a, b) => b[0].length - a[0].length);
  let content = m.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  for (const [name, p] of names) {
    content = content.replace(new RegExp(`@${name}\\b`, "g"), () => {
      const id = mentions.length;
      mentions.push({ id, mentionText: name, mentioned: { device: null, user: { "@odata.type": "#microsoft.graph.teamworkUserIdentity", id: guid(p.addr), displayName: p.name, userIdentityType: "aadUser", tenantId: TENANT } } });
      return `<at id="${id}">${name}</at>`;
    });
  }
  const from = m.sender.bot
    ? { application: { "@odata.type": "#microsoft.graph.teamworkApplicationIdentity", id: guid(m.sender.addr), displayName: m.sender.name, applicationIdentityType: "bot" }, device: null, user: null }
    : { application: null, device: null, user: { "@odata.type": "#microsoft.graph.teamworkUserIdentity", id: guid(m.sender.addr), displayName: m.sender.name, userIdentityType: "aadUser", tenantId: TENANT } };
  return {
    "@odata.type": "#microsoft.graph.chatMessage",
    id: m.id,
    replyToId: m.replyToId,
    etag: m.id,
    messageType: "message",
    createdDateTime: m.at,
    lastModifiedDateTime: m.at,
    deletedDateTime: null,
    subject: null,
    summary: null,
    chatId: m.channel ? null : m.chatId,
    channelIdentity: m.channel ? { teamId: guid("ledgerline-eng"), channelId: m.chatId } : null,
    importance: "normal",
    locale: "en-us",
    webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(m.chatId)}/${m.id}`,
    from,
    body: { contentType: "html", content: `<p>${content.replaceAll("\n", "<br>")}</p>` },
    attachments: [],
    mentions,
    reactions: [],
  };
}

// Gmail shows the first of these labels a message carries as its place.
const GMAIL_CONTAINERS: [string, string][] = [
  ["CATEGORY_PROMOTIONS", "Promotions"],
  ["CATEGORY_UPDATES", "Updates"],
  ["CATEGORY_SOCIAL", "Social"],
  ["CATEGORY_FORUMS", "Forums"],
  ["CATEGORY_PERSONAL", "Primary"],
  ["SENT", "Sent"],
  ["INBOX", "Inbox"],
];
const PT_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const PT_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

/* A users.messages.get(format=full) object as the gws plugin keeps it: no MIME body.data, no transport or signature
   headers. Ids are a millisecond timestamp in the high bits, like Gmail's. */
function gmailMessages(t: Thread, people: Record<string, Person>, me: Person): Source[] {
  const fmt = (p: Person) => `${p.name} <${p.addr}>`;
  const msgId = (n: number) => `<${sha1(`${t.id}:${n}:mid`).slice(0, 24)}@${people[t.messages[n].from].addr.split("@")[1]}>`;
  const part = (partId: string, mimeType: string, size: number) => ({ partId, mimeType, filename: "", headers: [{ name: "Content-Type", value: `${mimeType}; charset="UTF-8"` }], body: { size } });
  let threadId = "";
  return t.messages.map((m, k) => {
    const ms = Date.parse(m.at);
    const id = ((BigInt(ms) << 20n) | BigInt(Number.parseInt(sha1(`${t.id}:${k}`).slice(0, 5), 16))).toString(16);
    threadId ||= id;
    const from = people[m.from];
    const to = m.to.map((x) => people[x]);
    const cc = (m.cc ?? []).map((x) => people[x]);
    const fromMe = from === me;
    const labelIds = fromMe ? (to.includes(me) ? ["SENT", ...t.labels] : ["SENT"]) : t.labels;
    const [containerId, containerName] = GMAIL_CONTAINERS.find(([l]) => labelIds.includes(l)) ?? ["INBOX", "Inbox"];
    const subject = k ? `Re: ${t.subject}` : t.subject;
    const prev = k && !t.headers?.["List-ID"] ? t.messages[k - 1] : null;
    const quoted = prev
      ? `On ${PT_DATE.format(Date.parse(prev.at))} at ${PT_TIME.format(Date.parse(prev.at))} ${fmt(people[prev.from])} wrote:\n${[prev.text, people[prev.from].signature ? `-- \n${people[prev.from].signature}` : ""].filter(Boolean).join("\n\n").replace(/^/gm, "> ").replace(/^> $/gm, ">")}`
      : "";
    const bodyQuoted = [from.signature ? `-- \n${from.signature}` : "", quoted].filter(Boolean).join("\n\n");
    const plainSize = Buffer.byteLength([m.text, bodyQuoted].filter(Boolean).join("\n\n"));
    const headers = [
      { name: "MIME-Version", value: "1.0" },
      { name: "Date", value: new Date(ms).toUTCString().replace("GMT", "+0000") },
      { name: "Message-ID", value: msgId(k) },
      ...(k ? [{ name: "In-Reply-To", value: msgId(k - 1) }, { name: "References", value: t.messages.slice(0, k).map((_, n) => msgId(n)).join(" ") }] : []),
      { name: "Subject", value: subject },
      { name: "From", value: fmt(from) },
      { name: "To", value: to.map(fmt).join(", ") },
      ...(cc.length ? [{ name: "Cc", value: cc.map(fmt).join(", ") }] : []),
      ...(fromMe ? [] : Object.entries(t.headers ?? {}).map(([name, value]) => ({ name, value }))),
      { name: "Content-Type", value: `multipart/alternative; boundary="000000000000${sha1(id).slice(0, 12)}"` },
    ];
    const raw = {
      id,
      threadId,
      labelIds,
      snippet: m.text.replace(/\]\([^)]*\)|[#*_`>[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 200),
      sizeEstimate: plainSize * 3 + 2000,
      internalDate: String(ms),
      payload: { partId: "", mimeType: "multipart/alternative", filename: "", headers, body: { size: 0 }, parts: [part("0", "text/plain", plainSize), part("1", "text/html", plainSize * 2)] },
    };
    return {
      id,
      source: "gmail",
      sourceLabel: `Gmail · ${containerName}`,
      threadId,
      containerId,
      containerName,
      title: subject,
      from: { name: from.name, addr: from.addr },
      occurredAt: new Date(ms).toISOString(),
      bodyNew: m.text,
      bodyQuoted,
      link: `https://mail.google.com/mail/u/0/#all/${threadId}`,
      raw,
    };
  });
}

function teamsMessages(chat: Chat, people: Record<string, Person>): Source[] {
  const members = chat.members.map((x) => people[x]);
  const channel = chat.kind === "channel";
  const chatId = channel ? `19:${chat.id}@thread.tacv2` : `19:${chat.id}@thread.v2`;
  const posts = new Map<string, string>();
  return chat.messages.map((m, k) => {
    const at = new Date(m.at);
    const msgId = String(at.getTime());
    if (m.post && !posts.has(m.post)) posts.set(m.post, msgId);
    const root = m.post ? posts.get(m.post)! : null;
    const threadId = channel ? `${chatId};messageid=${root}` : chatId;
    const sender = people[m.from];
    return {
      id: `${chat.id}-${at.getTime()}-${k}`,
      source: "teams",
      sourceLabel: `Teams · ${chat.kind === "chat" ? `#${chat.title}` : chat.title}`,
      threadId,
      containerId: `teams:${chat.id}`,
      containerName: chat.title,
      title: chat.title,
      from: { name: sender.name, addr: sender.addr },
      occurredAt: at.toISOString(),
      bodyNew: m.text,
      bodyQuoted: "",
      link: `https://teams.microsoft.com/l/message/${encodeURIComponent(threadId)}/${msgId}`,
      raw: graphMessage({ id: msgId, at: at.toISOString(), text: m.text, sender, replyToId: channel && root !== msgId ? root : null, chatId, channel }, members),
      kind: chat.kind,
    };
  });
}

export function expand(): { list: Source[]; seenCutoff: string; me: Data["me"] } {
  const s: Scenarios = JSON.parse(readFileSync(join(DIR, "scenarios.json"), "utf8"));
  const me = s.people[s.me];
  const list = [...s.chats.flatMap((c) => teamsMessages(c, s.people)), ...s.threads.flatMap((t) => gmailMessages(t, s.people, me))];
  return { list, seenCutoff: new Date(s.seenCutoff).toISOString(), me: { addrs: [me.addr], names: [me.name] } };
}

export const ruleInput = (s: Omit<Source, "kind">, fromMe: boolean): RuleInput => ({
  source: s.source,
  threadId: s.threadId,
  containerId: s.containerId,
  containerName: s.containerName,
  title: s.title,
  from: { name: s.from.name, address: s.from.addr.toLowerCase() },
  fromMe,
  body: [s.bodyNew, s.bodyQuoted].filter(Boolean).join("\n\n"),
  raw: s.raw,
});

// Conversation key: source + (threadId ?? containerId); a Teams channel is one conversation, so its key is the channel.
const keyOf = (s: Source) => (s.source === "teams" ? s.containerId : (s.threadId ?? s.id));

export function buildStructure(config: Config): { data: Data; itemTags: Map<string, string[]> } {
  const src = expand();
  const mine = new Set(src.me.addrs.map((a) => a.toLowerCase()));
  const groups = new Map<string, Source[]>();
  for (const s of src.list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) groups.set(keyOf(s), [...(groups.get(keyOf(s)) ?? []), s]);
  const items: Item[] = [];
  const conversations: Conv[] = [];
  const itemTags = new Map<string, string[]>();
  for (const [key, group] of groups) {
    const id = `c-${key}`;
    const tags = new Set<string>();
    const convItems = group.map(({ raw, kind: _, ...s }, k): Item => {
      const fromMe = mine.has(s.from.addr.toLowerCase());
      const t = tagsOfInput(config, ruleInput({ ...s, raw }, fromMe));
      itemTags.set(s.id, t);
      for (const x of t) tags.add(x);
      return { ...s, conversationId: id, seq: k + 1, fromMe };
    });
    items.push(...convItems);
    const first = convItems[0];
    const tagList = (config.tag ?? []).map((t) => t.name).filter((n) => tags.has(n));
    conversations.push({
      id,
      source: first.source,
      kind: first.source === "gmail" ? "email" : (group[0].kind ?? "chat"),
      title: first.source === "teams" ? first.containerName : first.title || "(无主题)",
      itemIds: convItems.map((i) => i.id),
      lastSeq: convItems.length,
      seenSeq: convItems.filter((i) => i.occurredAt <= src.seenCutoff).length,
      tags: tagList,
      since: sinceOf(config, tagList),
      firstAt: first.occurredAt,
      lastAt: convItems.at(-1)!.occurredAt,
    });
  }
  items.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  conversations.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  const data: Data = {
    generatedAt: new Date().toISOString(),
    seenCutoff: src.seenCutoff,
    me: src.me,
    digest: { threshold: config.digest.threshold, maxInput: config.digest.max_input, context: config.digest.context },
    tags: (config.tag ?? []).map((t) => ({ name: t.name, ai: !!t.ai, aiSince: t.ai ? (config.tag_state?.[t.name] ?? null) : null })),
    sources: [
      { id: "gmail", name: "Gmail" },
      { id: "teams", name: "Teams" },
    ],
    items,
    conversations,
    digests: [],
  };
  return { data, itemTags };
}

// Replays arrival order: after each item the conversation's tags and since are what the items so far say, and the auto
// range is checked at once (no quiet wait). A range is cut into chunks; the next check starts after the last chunk.
export function autoPlan(convItems: Item[], itemTags: Map<string, string[]>, config: Config): [number, number][][] {
  const planned: { fromSeq: number; toSeq: number }[] = [];
  const groups: [number, number][][] = [];
  const tags = new Set<string>();
  for (let k = 1; k <= convItems.length; k++) {
    for (const t of itemTags.get(convItems[k - 1].id) ?? []) tags.add(t);
    const so = convItems.slice(0, k);
    const r = autoRange(so, planned, sinceOf(config, [...tags]), config.digest.threshold);
    if (!r) continue;
    const group = chunks(so.slice(r[0] - 1, r[1]), config.digest.max_input);
    groups.push(group);
    for (const [a, b] of group) planned.push({ fromSeq: a, toSeq: b });
  }
  return groups;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
};

if (import.meta.main) {
  const config = loadConfig();
  const { data, itemTags } = buildStructure(config);
  const byConv = new Map(data.conversations.map((c) => [c.id, itemsOfConv(data, c.id)]));
  const ai = data.conversations.filter((c) => c.since);
  const tagCounts = Object.fromEntries(data.tags.map((t) => [t.name, data.conversations.filter((c) => c.tags.includes(t.name)).length]));
  const untagged = data.conversations.filter((c) => !c.tags.length).length;
  console.log(`structure: ${data.items.length} items, ${data.conversations.length} conversations, ${ai.length} AI-enabled, tags ${JSON.stringify(tagCounts)}, untagged ${untagged}`);
  if (process.argv.includes("--structure")) {
    await writeData(data);
    process.exit(0);
  }
  const plan = ai
    .map((conv) => {
      const groups = autoPlan(byConv.get(conv.id)!, itemTags, config);
      return { conv, groups, planned: groups.flat() };
    })
    .filter((p) => p.planned.length)
    .sort((a, b) => b.planned.length - a.planned.length);
  const total = plan.reduce((n, p) => n + p.planned.length, 0);
  console.log(`auto: ${total} digests over ${plan.length} conversations`);
  const logs: CallLog[] = [];
  const t0 = performance.now();
  await pool(plan, CONCURRENCY, async ({ conv, planned }) => {
    const items = byConv.get(conv.id)!;
    const done: Digest[] = [];
    for (const [fromSeq, toSeq] of planned) {
      const { digest, log } = await call({ conv, items, digests: done, me: data.me, fromSeq, toSeq, trigger: "auto", context: data.digest.context, logPrefix: "" });
      logs.push(log);
      console.log(`${conv.id} ${fromSeq}-${toSeq}: ${log.ms}ms ${log.ok ? "ok" : log.error} (${logs.length}/${total})`);
      if (!digest) break;
      done.push(digest);
    }
    data.digests.push(...done);
  });
  const wallMs = Math.round(performance.now() - t0);
  data.digests.sort((a, b) => a.conversationId.localeCompare(b.conversationId) || a.fromSeq - b.fromSeq);
  await writeData(data);

  const ms = logs.map((l) => l.ms);
  const fails = logs.filter((l) => !l.ok);
  const multiChunk = plan.flatMap((p) => p.groups.filter((g) => g.length > 1));
  const covered = (c: Conv) => data.digests.filter((d) => d.conversationId === c.id).reduce((n, d) => n + d.toSeq - d.fromSeq + 1, 0);
  const md = `# Digest run timing

Measured by \`bun data/digest.ts\` on ${new Date().toISOString().slice(0, 10)} (data.json written ${data.generatedAt}) over the synthetic \`data/scenarios.json\`. Config \`data/tags.toml\`: threshold ${config.digest.threshold} chars of \`bodyNew\`, max input ${config.digest.max_input}, context ${config.digest.context}. Read state: items at or before ${data.seenCutoff} count as read.

- Model \`${MODEL}\`; command \`${CMD.join(" ")}\`, prompt on stdin, template \`data/prompts/digest-topics.md\`.
- Concurrency ${CONCURRENCY} across conversations; calls inside one conversation run in order. Up to 3 attempts per range.
- The auto chain replays arrival order: after each item, \`autoRange(items so far, digests so far, since, threshold)\`; a hit is cut into chunks of at most ${config.digest.max_input} chars.

## Counts

- Items: ${data.items.length}. Conversations: ${data.conversations.length} (gmail ${data.conversations.filter((c) => c.source === "gmail").length}, teams ${data.conversations.filter((c) => c.source === "teams").length}).
- Tags (conversations, overlapping): ${data.tags.map((t) => `${t.name} ${tagCounts[t.name]}${t.ai ? ` (ai, since ${t.aiSince})` : ""}`).join(", ")}; Untagged ${untagged}.
- AI-enabled conversations: ${ai.length}; with at least one auto digest: ${plan.length}.
- Auto digests: ${data.digests.length} of ${total} planned. Ranges that were cut into more than one chunk: ${multiChunk.length}.
- Items covered by a digest in AI-enabled conversations: ${ai.reduce((n, c) => n + covered(c), 0)} of ${ai.reduce((n, c) => n + c.lastSeq, 0)}; items before \`since\` (left as originals): ${ai.reduce((n, c) => n + byConv.get(c.id)!.filter((i) => Date.parse(i.occurredAt) < Date.parse(c.since!)).length, 0)}.

## Calls

- Calls: ${logs.length} (${logs.length - fails.length} ok, ${fails.length} failed after 3 attempts; ${logs.filter((l) => l.ok && l.attempts > 1).length} ok on a retry). Wall ${wallMs} ms.
- Latency per call, ms (includes retries): min ${Math.min(...ms)}, median ${pct(ms, 50)}, p90 ${pct(ms, 90)}, max ${Math.max(...ms)}.
- Prompt input chars: median ${pct(logs.map((l) => l.inputChars), 50)}, max ${Math.max(...logs.map((l) => l.inputChars))}. Context chars: median ${pct(logs.map((l) => l.contextChars), 50)}.
${fails.map((f) => `- Failed: ${f.conversationId} #${f.fromSeq}-#${f.toSeq}: ${f.error}`).join("\n")}

## AI-enabled conversations

| conversation | tags | since | items | before since | auto digests |
|---|---|---|---|---|---|
${ai.map((c) => `| ${c.id} | ${c.tags.join(", ")} | ${c.since} | ${c.lastSeq} | ${byConv.get(c.id)!.filter((i) => Date.parse(i.occurredAt) < Date.parse(c.since!)).length} | ${data.digests.filter((d) => d.conversationId === c.id).map((d) => `#${d.fromSeq}-#${d.toSeq}`).join(" ") || "none"} |`).join("\n")}

## All conversations

| conversation | kind | title | items | read | tags |
|---|---|---|---|---|---|
${data.conversations.map((c) => `| ${c.id} | ${c.kind} | ${c.title.replaceAll("|", "\\|")} | ${c.lastSeq} | ${c.seenSeq} | ${c.tags.join(", ") || "Untagged"} |`).join("\n")}
`;
  await Bun.write(join(OUT_DIR, "timing.md"), md);
  console.log(`digests: ${data.digests.length} ok, ${fails.length} failed, wall ${wallMs}ms`);
}
