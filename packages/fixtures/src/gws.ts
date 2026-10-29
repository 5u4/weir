import type { Message } from "./gmail.ts";
import {
  HISTORY_FIELDS,
  type History,
  type HistoryType,
  type Mailbox,
  parseClock,
} from "./mailbox.ts";

export type GwsResult = { stdout: string; stderr: string; exitCode: number; delayMs: number };
type Params = Record<string, unknown>;

class GwsError extends Error {
  readonly kind: "api" | "validation";
  readonly code: number;
  readonly reason: string;
  constructor(kind: "api" | "validation", code: number, reason: string, message: string) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.reason = reason;
  }
}

const validation = (message: string) => new GwsError("validation", 400, "validationError", message);
const invalidArgument = (message: string) => new GwsError("api", 400, "invalidArgument", message);
const notFound = () => new GwsError("api", 404, "notFound", "Requested entity was not found.");

const userOf = (mailbox: Mailbox, p: Params) => {
  if (p.userId === undefined) throw validation("Required path parameter 'userId' is missing");
  if (p.userId !== "me" && p.userId !== mailbox.emailAddress) {
    throw new GwsError("api", 403, "forbidden", `Delegation denied for ${mailbox.emailAddress}`);
  }
};

const intParam = (p: Params, name: string, fallback: number, max: number) => {
  const raw = p[name];
  if (raw === undefined) return fallback;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw invalidArgument(`Invalid ${name}: ${String(raw)}`);
  return n;
};

const boolParam = (p: Params, name: string) => {
  const raw = p[name];
  if (raw === undefined || raw === false || raw === "false") return false;
  if (raw === true || raw === "true") return true;
  throw invalidArgument(`Invalid ${name}: ${String(raw)}`);
};

const page = <T>(items: T[], p: Params, size: number) => {
  const token = p.pageToken;
  const start = token === undefined ? 0 : typeof token === "string" ? Number(token) : Number.NaN;
  if (!Number.isInteger(start) || start < 0 || start > items.length) {
    throw invalidArgument(`Invalid pageToken: ${String(token)}`);
  }
  const end = start + size;
  return {
    items: items.slice(start, end),
    nextPageToken: end < items.length ? String(end) : undefined,
  };
};

const newerThanCutoff = (mailbox: Mailbox, q: unknown): number => {
  if (q === undefined) return Number.NEGATIVE_INFINITY;
  if (typeof q !== "string") throw invalidArgument(`Invalid q: ${String(q)}`);
  const trimmed = q.trim();
  if (trimmed === "") return Number.NEGATIVE_INFINITY;
  const m = /^newer_than:(\d+)([dmy])$/.exec(trimmed);
  if (!m) throw validation(`fake-gws supports only an empty q or newer_than:N[dmy], got "${q}"`);
  const n = Number(m[1]);
  const { local, offsetMinutes } = parseClock(mailbox.now);
  return (
    Date.UTC(
      local.getUTCFullYear() - (m[2] === "y" ? n : 0),
      local.getUTCMonth() - (m[2] === "m" ? n : 0),
      local.getUTCDate() - (m[2] === "d" ? n : 0),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
    ) -
    offsetMinutes * 60_000
  );
};

const labelIdOf = (mailbox: Mailbox, raw: unknown): string | undefined => {
  const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (values.length > 1) {
    throw validation(`fake-gws supports at most one labelIds value, got ${values.length}`);
  }
  const [id] = values;
  if (id === undefined) return undefined;
  if (typeof id !== "string" || !mailbox.labels.some((l) => l.id === id)) {
    throw invalidArgument(`Invalid label: ${String(id)}`);
  }
  return id;
};

const listThreads = (mailbox: Mailbox, p: Params) => {
  userOf(mailbox, p);
  const cutoff = newerThanCutoff(mailbox, p.q);
  const withSpamTrash = boolParam(p, "includeSpamTrash");
  const labelId = labelIdOf(mailbox, p.labelIds);
  const newest = new Map<string, Message>();
  for (const m of Object.values(mailbox.messages)) {
    if (
      Number(m.internalDate) > cutoff &&
      (withSpamTrash || !m.labelIds.some((l) => l === "SPAM" || l === "TRASH")) &&
      (labelId === undefined || m.labelIds.includes(labelId))
    ) {
      const seen = newest.get(m.threadId);
      if (seen === undefined || Number(m.internalDate) > Number(seen.internalDate)) {
        newest.set(m.threadId, m);
      }
    }
  }
  const matching = [...newest.values()].sort(
    (a, b) => Number(b.internalDate) - Number(a.internalDate) || b.id.localeCompare(a.id),
  );
  const size = Math.min(intParam(p, "maxResults", 100, 500), mailbox.pageSize);
  const { items, nextPageToken } = page(matching, p, size);
  return {
    ...(items.length
      ? {
          threads: items.map((m) => ({ id: m.threadId, snippet: m.snippet })),
        }
      : {}),
    ...(nextPageToken ? { nextPageToken } : {}),
    resultSizeEstimate: matching.length,
  };
};

const getThread = (mailbox: Mailbox, p: Params) => {
  userOf(mailbox, p);
  if (p.format !== undefined && p.format !== "full") {
    throw validation(`fake-gws supports only format "full", got "${String(p.format)}"`);
  }
  if (typeof p.id !== "string") throw validation("Required path parameter 'id' is missing");
  const messages = Object.values(mailbox.messages)
    .filter((m) => m.threadId === p.id)
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id));
  if (!messages.length) throw notFound();
  const historyId = String(Math.max(...messages.map((m) => Number(m.historyId))));
  return { id: p.id, historyId, messages };
};

const listLabels = (mailbox: Mailbox, p: Params) => {
  userOf(mailbox, p);
  return { labels: mailbox.labels };
};

const historyTypesOf = (raw: unknown): HistoryType[] => {
  if (raw === undefined) return Object.keys(HISTORY_FIELDS) as HistoryType[];
  const values = Array.isArray(raw) ? raw : [raw];
  for (const v of values) {
    if (typeof v !== "string" || !Object.hasOwn(HISTORY_FIELDS, v)) {
      throw invalidArgument(`Invalid value at 'history_types': ${String(v)}`);
    }
  }
  return values as HistoryType[];
};

const listHistory = (mailbox: Mailbox, p: Params) => {
  userOf(mailbox, p);
  const rawStart = p.startHistoryId;
  if (rawStart === undefined) throw invalidArgument("Missing startHistoryId");
  const start =
    typeof rawStart === "number" || typeof rawStart === "string" ? Number(rawStart) : Number.NaN;
  if (!Number.isInteger(start) || start < 0)
    throw invalidArgument(`Invalid startHistoryId: ${String(rawStart)}`);
  if (start < Number(mailbox.historyFloor)) throw notFound();
  const fields = historyTypesOf(p.historyTypes).map((t) => HISTORY_FIELDS[t]);
  const records = mailbox.history
    .filter((h) => Number(h.id) > start)
    .flatMap((h): History[] => {
      const kept = fields.filter((f) => h[f] !== undefined);
      if (!kept.length) return [];
      return [
        { id: h.id, messages: h.messages, ...Object.fromEntries(kept.map((f) => [f, h[f]])) },
      ];
    });
  const size = Math.min(intParam(p, "maxResults", 100, 500), mailbox.pageSize);
  const { items, nextPageToken } = page(records, p, size);
  return {
    ...(items.length ? { history: items } : {}),
    ...(nextPageToken ? { nextPageToken } : {}),
    historyId: mailbox.historyId,
  };
};

const getProfile = (mailbox: Mailbox, p: Params) => {
  userOf(mailbox, p);
  const messages = Object.values(mailbox.messages);
  return {
    emailAddress: mailbox.emailAddress,
    messagesTotal: messages.length,
    threadsTotal: new Set(messages.map((m) => m.threadId)).size,
    historyId: mailbox.historyId,
  };
};

const listSendAs = (mailbox: Mailbox, p: Params) => {
  userOf(mailbox, p);
  return { sendAs: mailbox.sendAs };
};

const COMMANDS: Record<
  string,
  { params: string[]; run: (mailbox: Mailbox, p: Params) => unknown }
> = {
  "gmail users threads list": {
    params: ["userId", "labelIds", "q", "maxResults", "pageToken", "includeSpamTrash"],
    run: listThreads,
  },
  "gmail users threads get": { params: ["userId", "id", "format"], run: getThread },
  "gmail users labels list": { params: ["userId"], run: listLabels },
  "gmail users history list": {
    params: ["userId", "startHistoryId", "historyTypes", "maxResults", "pageToken"],
    run: listHistory,
  },
  "gmail users getProfile": { params: ["userId"], run: getProfile },
  "gmail users settings sendAs list": { params: ["userId"], run: listSendAs },
};

const parseArgs = (args: string[]) => {
  const words: string[] = [];
  let params: Params = {};
  let mailboxDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--mailbox" && i === 0) {
      mailboxDir = args[++i];
      if (mailboxDir === undefined)
        throw validation("error: a value is required for '--mailbox <DIR>'");
      continue;
    }
    if (arg === "--params") {
      const json = args[++i];
      if (json === undefined) throw validation("error: a value is required for '--params <JSON>'");
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        throw validation(`Invalid --params JSON: ${(e as Error).message}`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw validation("Invalid --params JSON: expected an object");
      }
      params = parsed as Params;
    } else if (arg.startsWith("-")) {
      throw validation(`error: fake-gws does not support '${arg}'`);
    } else {
      words.push(arg);
    }
  }
  return { command: words.join(" "), params, mailboxDir };
};

export const runGws = (
  args: string[],
  load: (mailboxDir: string | undefined) => Mailbox,
): GwsResult => {
  let delayMs = 0;
  try {
    const { command, params, mailboxDir } = parseArgs(args);
    const spec = COMMANDS[command];
    if (!spec) throw validation(`error: fake-gws does not support the command '${command}'`);
    const unsupported = Object.keys(params).filter((k) => !spec.params.includes(k));
    if (unsupported.length) {
      throw validation(
        `fake-gws does not support params ${unsupported.join(", ")} for '${command}'`,
      );
    }
    let mailbox: Mailbox;
    try {
      mailbox = load(mailboxDir);
    } catch (e) {
      throw validation(`fake-gws cannot read mailbox ${mailboxDir}: ${(e as Error).message}`);
    }
    delayMs = mailbox.delay?.[command.replace(/^gmail users /, "")] ?? 0;
    return {
      stdout: `${JSON.stringify(spec.run(mailbox, params), null, 2)}\n`,
      stderr: "",
      exitCode: 0,
      delayMs,
    };
  } catch (e) {
    if (!(e instanceof GwsError)) throw e;
    const body = { error: { code: e.code, message: e.message, reason: e.reason } };
    return {
      stdout: `${JSON.stringify(body, null, 2)}\n`,
      stderr: `error[${e.kind}]: ${e.message}\n`,
      exitCode: e.kind === "api" ? 1 : 3,
      delayMs,
    };
  }
};
