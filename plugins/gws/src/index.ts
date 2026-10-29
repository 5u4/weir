import type { RawItem, SourcePlugin, SyncPage } from "@weir/contract/Source";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import {
  type Command,
  GwsError,
  getProfile,
  getThread,
  listHistory,
  listLabels,
  listSendAs,
  listThreads,
} from "./gws.ts";
import { toRawItem } from "./item.ts";

const LabelIds = Schema.NonEmptyArray(Schema.String);
type LabelIds = typeof LabelIds.Type;

const GwsConfig = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(["gws"] as const)),
  ),
  backfill: Schema.String,
  labels: LabelIds.pipe(Schema.withDecodingDefaultKey(Effect.succeed(["INBOX", "SENT"] as const))),
});
export type GwsConfig = typeof GwsConfig.Type;

const Backfill = Schema.Struct({
  phase: Schema.Literal("backfill"),
  labels: LabelIds,
  startHistoryId: Schema.String,
  listing: LabelIds,
  pageToken: Schema.NullOr(Schema.String),
  fetched: Schema.Array(Schema.String),
});
type Backfill = typeof Backfill.Type;

const Incremental = Schema.Struct({
  phase: Schema.Literal("incremental"),
  labels: LabelIds,
  historyId: Schema.String,
  pageToken: Schema.NullOr(Schema.String),
  pending: Schema.Array(Schema.String),
});
type Incremental = typeof Incremental.Type;

const Cursor = Schema.fromJsonString(Schema.Union([Backfill, Incremental]));
type Cursor = typeof Cursor.Type;
const encodeCursor = Schema.encodeSync(Cursor);
const decodeCursor = Schema.decodeUnknownSync(Cursor);
const sameLabels = Arr.makeEquivalence(Equivalence.String);

const newPass = (labels: LabelIds, startHistoryId: string): Backfill => ({
  phase: "backfill",
  labels,
  startHistoryId,
  listing: labels,
  pageToken: null,
  fetched: [],
});

const LIST_SIZE = 100;
const PAGE_MESSAGES = 100;
const CONCURRENCY = 8;
const HIDDEN: Record<string, true> = { SPAM: true, TRASH: true };

const isNotFound = (error: unknown): error is GwsError =>
  error instanceof GwsError && error.code === 404;

const resolveLabels = async (
  command: Command,
  names: LabelIds,
  signal: AbortSignal,
): Promise<LabelIds> => {
  const { labels = [] } = await listLabels(command, signal);
  const idByName = new Map(labels.map((label) => [label.name, label.id]));
  const ids = Arr.map(names, (name) => {
    const id = idByName.get(name);
    if (id === undefined) throw new Error(`Gmail has no label named "${name}"`);
    if (HIDDEN[id]) throw new Error(`weir does not sync the Gmail label "${name}"`);
    return id;
  });
  return Arr.sort(Arr.dedupe(ids), Order.String);
};

const fetchPage = async (
  command: Command,
  emailAddress: string,
  labels: LabelIds,
  threadIds: ReadonlyArray<string>,
  signal: AbortSignal,
) => {
  const upserts: RawItem[] = [];
  const deletions: string[] = [];
  let next = 0;
  while (next < threadIds.length && upserts.length + deletions.length < PAGE_MESSAGES) {
    const width = Math.min(CONCURRENCY, PAGE_MESSAGES - upserts.length - deletions.length);
    const threads = await Promise.all(
      threadIds.slice(next, next + width).map((id) =>
        getThread(command, id, signal).catch((error: unknown) => {
          if (isNotFound(error)) return { messages: [] };
          throw error;
        }),
      ),
    );
    next += width;
    for (const { messages = [] } of threads) {
      if (!messages.some((m) => m.labelIds?.some((label) => labels.includes(label)))) continue;
      for (const message of messages) {
        if (message.labelIds?.some((label) => HIDDEN[label])) {
          deletions.push(message.id);
        } else {
          upserts.push(toRawItem(message, emailAddress));
        }
      }
    }
  }
  return { upserts, deletions, rest: threadIds.slice(next) };
};

type Named = {
  readonly deleted: ReadonlySet<string>;
  readonly threads: ReadonlyArray<string>;
  readonly after: Incremental;
};

const create = ({ command, backfill, labels: labelNames }: GwsConfig) => {
  const backfillPage = async (
    emailAddress: string,
    position: Backfill,
    signal: AbortSignal,
  ): Promise<SyncPage> => {
    const { labels, startHistoryId, listing, pageToken } = position;
    const [label, ...rest] = listing;
    const list = await listThreads(command, label, backfill, pageToken, LIST_SIZE, signal);
    const fetched = new Set(position.fetched);
    const unfetched = (list.threads ?? []).map((t) => t.id).filter((id) => !fetched.has(id));
    const page = await fetchPage(command, emailAddress, labels, unfetched, signal);
    for (const id of unfetched.slice(0, unfetched.length - page.rest.length)) fetched.add(id);
    const carried = { phase: "backfill", labels, startHistoryId, fetched: [...fetched] } as const;
    const next: Cursor =
      page.rest.length > 0
        ? { ...carried, listing, pageToken }
        : list.nextPageToken !== undefined
          ? { ...carried, listing, pageToken: list.nextPageToken }
          : Arr.isReadonlyArrayNonEmpty(rest)
            ? { ...carried, listing: rest, pageToken: null }
            : {
                phase: "incremental",
                labels,
                historyId: startHistoryId,
                pageToken: null,
                pending: [],
              };
    return {
      upserts: page.upserts,
      deletions: page.deletions,
      cursor: encodeCursor(next),
      more: true,
      kind: "backfill",
      backfill: next.phase === "backfill" ? "running" : "done",
    };
  };

  const readHistory = async (position: Incremental, signal: AbortSignal): Promise<Named> => {
    if (position.pending.length > 0) {
      return { deleted: new Set(), threads: position.pending, after: position };
    }
    const history = await listHistory(command, position.historyId, position.pageToken, signal);
    const deleted = new Set<string>();
    const threads = new Set<string>();
    for (const record of history.history ?? []) {
      for (const { message } of record.messagesDeleted ?? []) deleted.add(message.id);
      for (const { message } of record.messagesAdded ?? []) threads.add(message.threadId);
      for (const { message, labelIds } of record.labelsAdded ?? []) {
        if (labelIds.some((label) => position.labels.includes(label))) {
          threads.add(message.threadId);
        }
      }
    }
    const after: Incremental =
      history.nextPageToken === undefined
        ? { ...position, historyId: history.historyId, pageToken: null }
        : { ...position, pageToken: history.nextPageToken };
    return { deleted, threads: [...threads], after };
  };

  const incrementalPage = async (
    emailAddress: string,
    restartHistoryId: string,
    position: Incremental,
    signal: AbortSignal,
  ): Promise<SyncPage> => {
    let named: Named;
    try {
      named = await readHistory(position, signal);
    } catch (error) {
      if (isNotFound(error)) {
        return backfillPage(emailAddress, newPass(position.labels, restartHistoryId), signal);
      }
      throw error;
    }
    const { deleted, threads, after } = named;
    const page = await fetchPage(command, emailAddress, position.labels, threads, signal);
    const next: Incremental = { ...after, pending: page.rest };
    return {
      upserts: page.upserts.filter((item) => !deleted.has(item.externalId)),
      deletions: [...new Set([...deleted, ...page.deletions])],
      cursor: encodeCursor(next),
      more: next.pending.length > 0 || next.pageToken !== null,
      kind: "live",
      backfill: "done",
    };
  };

  return {
    streams: async () => {
      const [profile, sendAs] = await Promise.all([getProfile(command), listSendAs(command)]);
      return [
        {
          id: profile.emailAddress,
          kind: "message" as const,
          name: profile.emailAddress,
          me: [
            ...new Set([
              profile.emailAddress,
              ...(sendAs.sendAs ?? []).map((alias) => alias.sendAsEmail),
            ]),
          ],
          openLabel: "Gmail",
        },
      ];
    },
    sync: async (
      streamId: string,
      cursor: string | null,
      signal: AbortSignal,
    ): Promise<SyncPage> => {
      const position = cursor === null ? null : decodeCursor(cursor);
      const [profile, labels] = await Promise.all([
        getProfile(command, signal),
        resolveLabels(command, labelNames, signal),
      ]);
      if (streamId !== profile.emailAddress) {
        throw new Error(`gws has no stream ${streamId}; the mailbox is ${profile.emailAddress}`);
      }
      if (position === null) {
        return backfillPage(profile.emailAddress, newPass(labels, profile.historyId), signal);
      }
      if (!sameLabels(position.labels, labels)) {
        const checkpoint =
          position.phase === "backfill" ? position.startHistoryId : position.historyId;
        return backfillPage(profile.emailAddress, newPass(labels, checkpoint), signal);
      }
      switch (position.phase) {
        case "backfill":
          return backfillPage(profile.emailAddress, position, signal);
        case "incremental":
          return incrementalPage(profile.emailAddress, profile.historyId, position, signal);
      }
    },
  };
};

export const gws: SourcePlugin<GwsConfig> = {
  id: "gws",
  configSchema: Schema.toStandardSchemaV1(GwsConfig),
  create,
};
