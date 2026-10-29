import expectedDigestsJson from "../expected-digests.json" with { type: "json" };
import expected from "../expected-tags.json" with { type: "json" };
import {
  deliverNext,
  expire,
  parseClock,
  readMailbox,
  relabelMessage,
  removeMessage,
  seed,
  seedWith,
  writeMailbox,
} from "./mailbox.ts";
import type { Thread } from "./scenarios.ts";

export type { Thread };

export const FIXTURE_NOW = "2026-10-25T09:00:00-07:00";

export type TagCount = { conversations: number; items: number };
export type ExpectedTags = {
  source: string;
  conversations: number;
  items: number;
  tags: Record<"Me" | "On-call" | "GitHub" | "Promos", TagCount>;
  untagged: TagCount;
};
export const expectedTags: ExpectedTags = expected;

export type ExpectedDigest = {
  conversation: string;
  first_occurred_at: string;
  last_occurred_at: string;
  items: number;
  trigger: "auto" | "manual";
  ai_profile: string;
};
export const expectedDigests: { ai_since: string; digests: ExpectedDigest[] } =
  expectedDigestsJson as { ai_since: string; digests: ExpectedDigest[] };

const tomlString = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const configToml = ({
  mailbox,
  gws = ["fake-gws"],
  ai = ["fake-ai"],
}: {
  mailbox?: string;
  gws?: ReadonlyArray<string>;
  ai?: ReadonlyArray<string>;
} = {}): string => {
  const command = [...gws, ...(mailbox === undefined ? [] : ["--mailbox", mailbox])];
  return String.raw`[ai.fake-ai]
command = [${ai.map(tomlString).join(", ")}]
timeout = "30s"
concurrency = 1

[digest]
ai = "fake-ai"
threshold = 1000
max_input = 24000
context = 6000

[[source]]
id = "gmail"
plugin = "gws"
sync_every = "5m"

[source.config]
command = [${command.map(tomlString).join(", ")}]
backfill = "newer_than:30d"

[[tag]]
name = "Me"
ai = true
match = { type = "or", rules = [
  { type = "and", rules = [
    { type = "eq", target = "/fromMe", is = true },
    { type = "or", rules = [
      { type = "eq", target = "/source", is = "teams" },
      { type = "some", target = "/raw/payload/headers", rule = { type = "and", rules = [
        { type = "regex", target = "/name", regex = "^(to|cc)$", flags = "i" },
        { type = "regex", target = "/value", regex = "(^|[\\s<,\"])(?!robin\\.ellis@example\\.com)[\\w.+-]+@", flags = "i" },
      ] } },
    ] },
  ] },
  { type = "some", target = "/raw/mentions", rule = { type = "eq", target = "/mentioned/user/id", is = "cd40ef40-540e-43c4-a09d-cc3aacb7cdc8" } },
  { type = "and", rules = [
    { type = "eq", target = "/source", is = "gmail" },
    { type = "eq", target = "/fromMe", is = false },
    { type = "some", target = "/raw/payload/headers", rule = { type = "and", rules = [
      { type = "regex", target = "/name", regex = "^to$", flags = "i" },
      { type = "regex", target = "/value", regex = "^[^,]*robin\\.ellis@example\\.com[^,]*$", flags = "i" },
    ] } },
    { type = "not", rule = { type = "some", target = "/raw/payload/headers", rule = { type = "regex", target = "/name", regex = "^(cc|list-unsubscribe)$", flags = "i" } } },
    { type = "not", rule = { type = "regex", target = "/from/address", regex = "no-?reply|notifications?@|mailer-daemon", flags = "i" } },
    { type = "not", rule = { type = "regex", target = "/from/address", regex = "@kokoro-ramen\\.example$", flags = "i" } },
    { type = "some", target = "/raw/labelIds", rule = { type = "eq", target = "", is = "CATEGORY_PERSONAL" } },
  ] },
] }

[[tag]]
name = "On-call"
ai = true
match = { type = "regex", target = "/containerName", regex = "oncall|war-room" }

[[tag]]
name = "GitHub"
match = { type = "some", target = "/raw/payload/headers", rule = { type = "and", rules = [
  { type = "regex", target = "/name", regex = "^from$", flags = "i" },
  { type = "regex", target = "/value", regex = "@github\\.example>?$", flags = "i" },
] } }

[[tag]]
name = "Promos"
match = { type = "some", target = "/raw/labelIds", rule = { type = "eq", target = "", is = "CATEGORY_PROMOTIONS" } }
`;
};

export const seedMailbox = (dir: string, options: { until?: string } = {}) => {
  const now = options.until ?? FIXTURE_NOW;
  const mailbox = seed(now);
  writeMailbox(dir, mailbox);
  return {
    historyId: mailbox.historyId,
    delivered: Object.keys(mailbox.messages).length,
    pending: mailbox.pending.length,
  };
};

export const seedThreads = (
  dir: string,
  threads: ReadonlyArray<Thread>,
  options: { now: string; pageSize: number },
) => {
  const mailbox = seedWith(options.now, threads);
  mailbox.pageSize = options.pageSize;
  writeMailbox(dir, mailbox);
  return { delivered: Object.keys(mailbox.messages).length };
};

export const deliver = (dir: string, n = 1): string[] => {
  const mailbox = readMailbox(dir);
  const ids = deliverNext(mailbox, n);
  writeMailbox(dir, mailbox);
  return ids;
};

export const remove = (dir: string, id: string) => {
  const mailbox = readMailbox(dir);
  removeMessage(mailbox, id);
  writeMailbox(dir, mailbox);
};

export const relabel = (dir: string, id: string, change: { add?: string[]; remove?: string[] }) => {
  const mailbox = readMailbox(dir);
  relabelMessage(mailbox, id, change);
  writeMailbox(dir, mailbox);
};

export const expireHistory = (dir: string) => {
  const mailbox = readMailbox(dir);
  expire(mailbox);
  writeMailbox(dir, mailbox);
};

export const setNow = (dir: string, iso: string) => {
  parseClock(iso);
  const mailbox = readMailbox(dir);
  mailbox.now = iso;
  writeMailbox(dir, mailbox);
};

export const setDelay = (dir: string, delay: Record<string, number>) => {
  const mailbox = readMailbox(dir);
  mailbox.delay = delay;
  writeMailbox(dir, mailbox);
};
