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
  type HistoryList,
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
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fetched: Schema.Array(Schema.String),
});
type Backfill = typeof Backfill.Type;

const Cursor = Schema.fromJsonString(
  Schema.Union([
    Backfill,
    Schema.Struct({
      phase: Schema.Literal("incremental"),
      labels: LabelIds,
      historyId: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
    }),
  ]),
);
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
  offset: 0,
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

const fetchThreads = async (
  command: Command,
  emailAddress: string,
  labels: LabelIds,
  threadIds: Iterable<string>,
  signal: AbortSignal,
) => {
  const ids = [...threadIds];
  const upserts: RawItem[] = [];
  const deletions: string[] = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const threads = await Promise.all(
      ids.slice(i, i + CONCURRENCY).map((id) =>
        getThread(command, id, signal).catch((error: unknown) => {
          if (isNotFound(error)) return { messages: [] };
          throw error;
        }),
      ),
    );
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
  return { upserts, deletions };
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
    const listed = (list.threads ?? []).map((t) => t.id);
    const fetched = new Set(position.fetched);
    const upserts: RawItem[] = [];
    const deletions: string[] = [];
    let offset = position.offset;
    while (offset < listed.length && upserts.length + deletions.length < PAGE_MESSAGES) {
      const width = Math.min(CONCURRENCY, PAGE_MESSAGES - upserts.length - deletions.length);
      const batch: string[] = [];
      for (; offset < listed.length && batch.length < width; offset++) {
        const id = listed[offset];
        if (id !== undefined && !fetched.has(id)) batch.push(id);
      }
      const page = await fetchThreads(command, emailAddress, labels, batch, signal);
      upserts.push(...page.upserts);
      deletions.push(...page.deletions);
      for (const id of batch) fetched.add(id);
    }
    const carried = { labels, startHistoryId, fetched: [...fetched] };
    const next: Cursor =
      offset < listed.length
        ? { phase: "backfill", ...carried, listing, pageToken, offset }
        : list.nextPageToken !== undefined
          ? { phase: "backfill", ...carried, listing, pageToken: list.nextPageToken, offset: 0 }
          : Arr.isReadonlyArrayNonEmpty(rest)
            ? { phase: "backfill", ...carried, listing: rest, pageToken: null, offset: 0 }
            : { phase: "incremental", labels, historyId: startHistoryId, pageToken: null };
    const more = next.phase === "backfill";
    return {
      upserts,
      deletions,
      cursor: encodeCursor(next),
      more,
      kind: "backfill",
      backfill: more ? "running" : "done",
    };
  };

  const incrementalPage = async (
    emailAddress: string,
    labels: LabelIds,
    restartHistoryId: string,
    historyId: string,
    pageToken: string | null,
    signal: AbortSignal,
  ): Promise<SyncPage> => {
    let history: HistoryList;
    try {
      history = await listHistory(command, historyId, pageToken, signal);
    } catch (error) {
      if (isNotFound(error)) {
        return backfillPage(emailAddress, newPass(labels, restartHistoryId), signal);
      }
      throw error;
    }
    const deleted = new Set<string>();
    const threads = new Set<string>();
    for (const record of history.history ?? []) {
      for (const { message } of record.messagesDeleted ?? []) deleted.add(message.id);
      for (const { message } of record.messagesAdded ?? []) threads.add(message.threadId);
      for (const { message, labelIds } of record.labelsAdded ?? []) {
        if (labelIds.some((label) => labels.includes(label))) threads.add(message.threadId);
      }
    }
    const page = await fetchThreads(command, emailAddress, labels, threads, signal);
    const next: Cursor =
      history.nextPageToken === undefined
        ? { phase: "incremental", labels, historyId: history.historyId, pageToken: null }
        : { phase: "incremental", labels, historyId, pageToken: history.nextPageToken };
    return {
      upserts: page.upserts.filter((item) => !deleted.has(item.externalId)),
      deletions: [...new Set([...deleted, ...page.deletions])],
      cursor: encodeCursor(next),
      more: next.pageToken !== null,
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
          return incrementalPage(
            profile.emailAddress,
            labels,
            profile.historyId,
            position.historyId,
            position.pageToken,
            signal,
          );
      }
    },
  };
};

export const gws: SourcePlugin<GwsConfig> = {
  id: "gws",
  configSchema: Schema.toStandardSchemaV1(GwsConfig),
  create,
};
