import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GeneratedMessage, gmailMessages, type Message } from "./gmail.ts";
import { scenarios, type Thread } from "./scenarios.ts";

export type HistoryMessage = { id: string; threadId: string; labelIds?: string[] };
export type HistoryLabelChange = { message: HistoryMessage; labelIds: string[] };
export type History = {
  id: string;
  messages: HistoryMessage[];
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: HistoryLabelChange[];
  labelsRemoved?: HistoryLabelChange[];
};
export type HistoryType = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";
export const HISTORY_FIELDS: Record<HistoryType, keyof History> = {
  messageAdded: "messagesAdded",
  messageDeleted: "messagesDeleted",
  labelAdded: "labelsAdded",
  labelRemoved: "labelsRemoved",
};

export type SendAs = {
  sendAsEmail: string;
  displayName: string;
  replyToAddress: string;
  signature: string;
  isPrimary: boolean;
  isDefault: boolean;
  treatAsAlias: boolean;
  verificationStatus: string;
};

export type Mailbox = {
  now: string;
  historyFloor: string;
  historyId: string;
  pageSize: number;
  emailAddress: string;
  sendAs: SendAs[];
  messages: Record<string, Message>;
  pending: string[];
  history: History[];
  delay?: Record<string, number>;
};

const INITIAL_HISTORY_ID = 100_000;
const PAGE_SIZE = 10;
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|([+-])(\d{2}):(\d{2}))$/;

export const parseClock = (iso: string) => {
  const m = CLOCK.exec(iso);
  const epochMs = Date.parse(iso);
  const invalid = new Error(`not a real YYYY-MM-DDTHH:MM:SS with an offset: ${iso}`);
  if (!m || Number.isNaN(epochMs)) throw invalid;
  const offsetMinutes =
    m[1] === "Z" ? 0 : (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
  const local = new Date(epochMs + offsetMinutes * 60_000);
  if (local.toISOString().slice(0, 19) !== iso.slice(0, 19)) throw invalid;
  return { epochMs, local, offsetMinutes };
};

const generated: ReadonlyMap<string, GeneratedMessage> = new Map(
  gmailMessages(scenarios)
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id))
    .map((m) => [m.id, m]),
);

const record = (mailbox: Mailbox, entry: Omit<History, "id">): string => {
  const id = String(Number(mailbox.historyId) + 1);
  mailbox.historyId = id;
  mailbox.history.push({ id, ...entry });
  return id;
};

const ref = (m: Message): HistoryMessage => ({ id: m.id, threadId: m.threadId });

const deliverOne = (mailbox: Mailbox, draft: GeneratedMessage) => {
  const message: Message = { ...draft, labelIds: [...draft.labelIds], historyId: "" };
  message.historyId = record(mailbox, {
    messages: [ref(message)],
    messagesAdded: [{ message: { ...ref(message), labelIds: [...message.labelIds] } }],
  });
  mailbox.messages[message.id] = message;
};

const empty = (now: string): Mailbox => {
  parseClock(now);
  const me = scenarios.people[scenarios.me];
  if (!me) throw new Error(`scenarios.me names unknown person ${scenarios.me}`);
  return {
    now,
    historyFloor: String(INITIAL_HISTORY_ID),
    historyId: String(INITIAL_HISTORY_ID),
    pageSize: PAGE_SIZE,
    emailAddress: me.addr,
    sendAs: [
      {
        sendAsEmail: me.addr,
        displayName: me.name,
        replyToAddress: "",
        signature: (me.signature ?? "").replaceAll("\n", "<br>"),
        isPrimary: true,
        isDefault: true,
        treatAsAlias: false,
        verificationStatus: "accepted",
      },
    ],
    messages: {},
    pending: [],
    history: [],
  };
};

export const seed = (now: string): Mailbox => {
  const cutoff = parseClock(now).epochMs;
  const mailbox = empty(now);
  for (const m of generated.values()) {
    if (Number(m.internalDate) <= cutoff) deliverOne(mailbox, m);
    else mailbox.pending.push(m.id);
  }
  return mailbox;
};

export const seedWith = (now: string, threads: ReadonlyArray<Thread>): Mailbox => {
  const mailbox = empty(now);
  const messages = gmailMessages({ ...scenarios, threads: [...threads] }).sort(
    (a, b) => Number(a.internalDate) - Number(b.internalDate) || a.id.localeCompare(b.id),
  );
  for (const m of messages) deliverOne(mailbox, m);
  return mailbox;
};

export const deliverNext = (mailbox: Mailbox, n: number): string[] => {
  const ids = mailbox.pending.splice(0, n);
  if (ids.length < n) throw new Error(`asked to deliver ${n}, only ${ids.length} pending`);
  for (const id of ids) {
    const draft = generated.get(id);
    if (!draft) throw new Error(`no generated message ${id}`);
    deliverOne(mailbox, draft);
  }
  return ids;
};

const delivered = (mailbox: Mailbox, id: string): Message => {
  const message = mailbox.messages[id];
  if (!message) throw new Error(`no delivered message ${id}`);
  return message;
};

export const removeMessage = (mailbox: Mailbox, id: string) => {
  const message = delivered(mailbox, id);
  delete mailbox.messages[id];
  record(mailbox, { messages: [ref(message)], messagesDeleted: [{ message: ref(message) }] });
};

export const relabelMessage = (
  mailbox: Mailbox,
  id: string,
  change: { add?: string[]; remove?: string[] },
) => {
  const message = delivered(mailbox, id);
  const added = [...new Set(change.add ?? [])].filter((l) => !message.labelIds.includes(l));
  const removed = [...new Set(change.remove ?? [])].filter((l) => message.labelIds.includes(l));
  if (!added.length && !removed.length) return;
  message.labelIds = [...message.labelIds.filter((l) => !removed.includes(l)), ...added];
  const after = { ...ref(message), labelIds: [...message.labelIds] };
  message.historyId = record(mailbox, {
    messages: [ref(message)],
    ...(added.length ? { labelsAdded: [{ message: after, labelIds: added }] } : {}),
    ...(removed.length ? { labelsRemoved: [{ message: after, labelIds: removed }] } : {}),
  });
};

export const expire = (mailbox: Mailbox) => {
  mailbox.historyId = String(Number(mailbox.historyId) + 1);
  mailbox.historyFloor = mailbox.historyId;
  mailbox.history = [];
};

export const mailboxFile = (dir: string) => join(dir, "mailbox.json");

export const readMailbox = (dir: string): Mailbox =>
  JSON.parse(readFileSync(mailboxFile(dir), "utf8")) as Mailbox;

export const writeMailbox = (dir: string, mailbox: Mailbox) => {
  mkdirSync(dir, { recursive: true });
  const file = mailboxFile(dir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(mailbox, null, 2)}\n`);
  renameSync(temp, file);
};
