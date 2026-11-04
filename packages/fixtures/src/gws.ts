import { localParts, type StoredEvent, zonedTime } from "./calendar.ts";
import type { Message } from "./gmail.ts";
import {
  HISTORY_FIELDS,
  type History,
  type HistoryType,
  type Mailbox,
  parseClock,
} from "./mailbox.ts";

export type GwsCall = { command: string; params: Record<string, unknown>; failed: boolean };
export type GwsResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  delayMs: number;
  log?: { mailboxDir: string; call: GwsCall };
};
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

const newerThanCutoff = (mailbox: Mailbox, [, amount, unit]: RegExpExecArray): number => {
  const n = Number(amount);
  const { local, offsetMinutes } = parseClock(mailbox.now);
  return (
    Date.UTC(
      local.getUTCFullYear() - (unit === "y" ? n : 0),
      local.getUTCMonth() - (unit === "m" ? n : 0),
      local.getUTCDate() - (unit === "d" ? n : 0),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
    ) -
    offsetMinutes * 60_000
  );
};

const QUERY_TERMS: ReadonlyArray<{
  pattern: RegExp;
  cutoff: (mailbox: Mailbox, match: RegExpExecArray) => number;
}> = [
  { pattern: /^newer_than:(\d+)([dmy])$/, cutoff: newerThanCutoff },
  { pattern: /^after:(\d+)$/, cutoff: (_, [, seconds]) => Number(seconds) * 1000 },
];

const queryCutoff = (mailbox: Mailbox, q: unknown): number => {
  if (q === undefined) return Number.NEGATIVE_INFINITY;
  if (typeof q !== "string") throw invalidArgument(`Invalid q: ${String(q)}`);
  const used = new Set<(typeof QUERY_TERMS)[number]>();
  let cutoff = Number.NEGATIVE_INFINITY;
  for (const term of q.trim().split(/\s+/).filter(Boolean)) {
    const spec = QUERY_TERMS.find((t) => t.pattern.test(term));
    const match = spec?.pattern.exec(term);
    if (!spec || !match || used.has(spec)) {
      throw validation(
        `fake-gws supports only an empty q, newer_than:N[dmy], after:N, or both, got "${q}"`,
      );
    }
    used.add(spec);
    cutoff = Math.max(cutoff, spec.cutoff(mailbox, match));
  }
  return cutoff;
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
  const cutoff = queryCutoff(mailbox, p.q);
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

const calendarOf = (mailbox: Mailbox, p: Params) => {
  if (p.calendarId === undefined)
    throw validation("Required path parameter 'calendarId' is missing");
  if (p.calendarId !== "primary" && p.calendarId !== mailbox.emailAddress) throw notFound();
  return mailbox.calendar;
};

const timeParam = (p: Params, name: string) => {
  const raw = p[name];
  if (raw === undefined) return undefined;
  const ms = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (Number.isNaN(ms)) throw invalidArgument(`Invalid ${name}: ${String(raw)}`);
  return ms;
};

const boundsOf = (event: Pick<StoredEvent, "start" | "end">) => ({
  start: Date.parse(event.start.dateTime ?? `${event.start.date}T00:00:00Z`),
  end: Date.parse(event.end.dateTime ?? `${event.end.date}T00:00:00Z`),
});

const wire = ({ version: _, ...event }: StoredEvent) => event;

const listEvents = (mailbox: Mailbox, p: Params) => {
  const calendar = calendarOf(mailbox, p);
  if (boolParam(p, "singleEvents")) {
    throw validation("fake-gws supports only singleEvents=false");
  }
  const all = Object.values(calendar.events).sort((a, b) => a.version - b.version);
  let matching: StoredEvent[];
  if (p.syncToken !== undefined) {
    if (p.timeMin !== undefined) {
      throw invalidArgument("syncToken cannot be used together with timeMin");
    }
    const token = typeof p.syncToken === "string" ? Number(p.syncToken) : Number.NaN;
    if (!Number.isInteger(token) || token < 0 || token > calendar.version) {
      throw new GwsError("api", 410, "fullSyncRequired", "Sync token is no longer valid.");
    }
    matching = all.filter((event) => event.version > token);
  } else {
    const timeMin = timeParam(p, "timeMin") ?? Number.NEGATIVE_INFINITY;
    matching = all.filter(
      (event) =>
        event.status !== "cancelled" &&
        (event.recurrence !== undefined || boundsOf(event).end > timeMin),
    );
  }
  const size = Math.min(intParam(p, "maxResults", 250, 2500), mailbox.pageSize);
  const { items, nextPageToken } = page(matching, p, size);
  return {
    kind: "calendar#events",
    summary: mailbox.emailAddress,
    timeZone: calendar.timeZone,
    items: items.map(wire),
    ...(nextPageToken ? { nextPageToken } : { nextSyncToken: String(calendar.version) }),
  };
};

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_MS = 86_400_000;

const listInstances = (mailbox: Mailbox, p: Params) => {
  const calendar = calendarOf(mailbox, p);
  if (typeof p.eventId !== "string")
    throw validation("Required path parameter 'eventId' is missing");
  const master = calendar.events[p.eventId];
  if (master === undefined || master.recurrence === undefined) throw notFound();
  if (master.status === "cancelled") {
    throw new GwsError("api", 410, "deleted", "Resource has been deleted");
  }
  const timeMin = timeParam(p, "timeMin");
  const timeMax = timeParam(p, "timeMax");
  if (timeMin === undefined || timeMax === undefined) {
    throw validation("fake-gws needs timeMin and timeMax to expand a recurring event");
  }
  const rule = /^RRULE:FREQ=WEEKLY;BYDAY=([A-Z,]+)$/.exec(master.recurrence[0] ?? "");
  if (rule === null || master.start.dateTime === undefined || master.end.dateTime === undefined) {
    throw validation(
      `fake-gws supports only timed FREQ=WEEKLY;BYDAY rules, got ${master.recurrence}`,
    );
  }
  const days = new Set(rule[1]?.split(","));
  const zone = master.start.timeZone ?? calendar.timeZone;
  const first = localParts(master.start.dateTime, zone);
  const endClock = localParts(master.end.dateTime, zone).clock;
  const instances: Array<Omit<StoredEvent, "version">> = [];
  for (let day = Date.parse(`${first.date}T00:00:00Z`); day <= timeMax + DAY_MS; day += DAY_MS) {
    if (!days.has(WEEKDAYS[new Date(day).getUTCDay()] ?? "")) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    const original = zonedTime(date, first.clock, zone);
    const id = `${master.id}_${new Date(original.utcMs).toISOString().replace(/[-:]|\.\d{3}/g, "")}`;
    const exception = calendar.events[id];
    const { version: _, recurrence: __, ...shared } = master;
    const instance =
      exception === undefined
        ? {
            ...shared,
            id,
            recurringEventId: master.id,
            originalStartTime: { dateTime: original.dateTime, timeZone: zone },
            start: { dateTime: original.dateTime, timeZone: zone },
            end: { dateTime: zonedTime(date, endClock, zone).dateTime, timeZone: zone },
          }
        : wire(exception);
    if (instance.status === "cancelled") continue;
    const bounds = boundsOf(instance);
    if (bounds.end > timeMin && bounds.start < timeMax) instances.push(instance);
  }
  const size = Math.min(intParam(p, "maxResults", 250, 2500), mailbox.pageSize);
  const { items, nextPageToken } = page(instances, p, size);
  return {
    kind: "calendar#events",
    summary: mailbox.emailAddress,
    timeZone: calendar.timeZone,
    items,
    ...(nextPageToken ? { nextPageToken } : {}),
  };
};

const PAGE_LIMIT = 10;

const COMMANDS: Record<
  string,
  { params: string[]; run: (mailbox: Mailbox, p: Params) => unknown; pageAll?: true }
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
  "calendar events list": {
    params: ["calendarId", "singleEvents", "maxResults", "syncToken", "timeMin", "pageToken"],
    run: listEvents,
  },
  "calendar events instances": {
    params: ["calendarId", "eventId", "timeMin", "timeMax", "maxResults", "pageToken"],
    run: listInstances,
    pageAll: true,
  },
};

const parseArgs = (args: string[]) => {
  const words: string[] = [];
  let params: Params = {};
  let mailboxDir: string | undefined;
  let pageAll = false;
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
    } else if (arg === "--page-all") {
      pageAll = true;
    } else if (arg.startsWith("-")) {
      throw validation(`error: fake-gws does not support '${arg}'`);
    } else {
      words.push(arg);
    }
  }
  return { command: words.join(" "), params, mailboxDir, pageAll };
};

export const runGws = (
  args: string[],
  load: (mailboxDir: string | undefined) => Mailbox,
  nowMs: number,
): GwsResult => {
  let delayMs = 0;
  let called: { mailboxDir: string; command: string; params: Params } | undefined;
  const finish = (stdout: string, stderr: string, exitCode: number): GwsResult => ({
    stdout,
    stderr,
    exitCode,
    delayMs,
    ...(called
      ? {
          log: {
            mailboxDir: called.mailboxDir,
            call: { command: called.command, params: called.params, failed: exitCode !== 0 },
          },
        }
      : {}),
  });
  try {
    const { command, params, mailboxDir, pageAll } = parseArgs(args);
    const method = command.replace(/^gmail users /, "");
    if (mailboxDir !== undefined) called = { mailboxDir, command: method, params };
    const spec = COMMANDS[command];
    if (!spec) throw validation(`error: fake-gws does not support the command '${command}'`);
    if (pageAll && !spec.pageAll) {
      throw validation(`error: fake-gws does not support '--page-all' for '${command}'`);
    }
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
    delayMs = mailbox.delay?.[method] ?? 0;
    if (mailbox.quota?.methods.includes(method) && nowMs < mailbox.quota.until) {
      throw new GwsError(
        "api",
        403,
        "rateLimitExceeded",
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
      );
    }
    if (!pageAll) {
      return finish(`${JSON.stringify(spec.run(mailbox, params), null, 2)}\n`, "", 0);
    }
    const lines: string[] = [];
    let pageParams = params;
    while (lines.length < PAGE_LIMIT) {
      const result = spec.run(mailbox, pageParams) as { nextPageToken?: string };
      lines.push(JSON.stringify(result));
      if (result.nextPageToken === undefined) break;
      pageParams = { ...params, pageToken: result.nextPageToken };
    }
    return finish(`${lines.join("\n")}\n`, "", 0);
  } catch (e) {
    if (!(e instanceof GwsError)) throw e;
    const body = { error: { code: e.code, message: e.message, reason: e.reason } };
    return finish(
      `${JSON.stringify(body, null, 2)}\n`,
      `error[${e.kind}]: ${e.message}\n`,
      e.kind === "api" ? 1 : 3,
    );
  }
};
