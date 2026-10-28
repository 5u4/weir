import {
  deliverNext,
  expire,
  ISO_WITH_OFFSET,
  readMailbox,
  relabelMessage,
  removeMessage,
  seed,
  writeMailbox,
} from "./mailbox.ts";

export const FIXTURE_NOW = "2026-10-25T09:00:00-07:00";

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
  if (!ISO_WITH_OFFSET.test(iso)) throw new Error(`not YYYY-MM-DDTHH:MM:SS with an offset: ${iso}`);
  const mailbox = readMailbox(dir);
  mailbox.now = iso;
  writeMailbox(dir, mailbox);
};
