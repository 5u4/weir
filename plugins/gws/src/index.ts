import type { RawItem, Source, SourcePlugin, SyncPage } from "@weir/contract/Source";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import {
  abortableSleep,
  type Gws,
  GwsError,
  getProfile,
  getThread,
  type HistoryList,
  listHistory,
  listLabels,
  listSendAs,
  listThreads,
  type Sleep,
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

const Live = Schema.Struct({
  historyId: Schema.String,
  pageToken: Schema.NullOr(Schema.String),
  watermark: Schema.Int,
  pending: Schema.Array(Schema.String),
});
type Live = typeof Live.Type;

const Listing = Schema.Struct({
  pageToken: Schema.NullOr(Schema.String),
  fetched: Schema.Array(Schema.String),
});
type Listing = typeof Listing.Type;

const Cursor = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      phase: Schema.Literal("backfill"),
      labels: LabelIds,
      listing: LabelIds,
      ...Listing.fields,
      live: Live,
      turn: Schema.Literals(["backfill", "live"]),
    }),
    Schema.Struct({
      phase: Schema.Literal("gap"),
      labels: LabelIds,
      after: Schema.Int,
      ...Listing.fields,
      live: Live,
    }),
    Schema.Struct({
      phase: Schema.Literal("incremental"),
      labels: LabelIds,
      live: Live,
    }),
  ]),
);
type Cursor = typeof Cursor.Type;
const encodeCursor = Schema.encodeSync(Cursor);
const decodeCursor = Schema.decodeUnknownSync(Cursor);
const sameLabels = Arr.makeEquivalence(Equivalence.String);

type Changes = { readonly upserts: RawItem[]; readonly deletions: string[] };
type Pass = {
  readonly emailAddress: string;
  readonly historyId: string;
  readonly recordedAt: number;
  readonly signal: AbortSignal;
};

const listingStart = (labels: LabelIds): Listing & { readonly listing: LabelIds } => ({
  listing: labels,
  pageToken: null,
  fetched: [],
});

const GAP_SLACK_SECONDS = 3600;
const HOLD_BACK_MS = 5 * 60_000;

const LIST_SIZE = 100;
const PAGE_MESSAGES = 100;
const CONCURRENCY = 8;
const HIDDEN: Record<string, true> = { SPAM: true, TRASH: true };

const isNotFound = (error: unknown): error is GwsError =>
  error instanceof GwsError && error.code === 404;

const resolveLabels = async (cli: Gws, names: LabelIds, signal: AbortSignal): Promise<LabelIds> => {
  const { labels = [] } = await listLabels(cli, signal);
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
  cli: Gws,
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
        getThread(cli, id, signal).catch((error: unknown) => {
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

const emit = (
  changes: Changes,
  next: Cursor,
  kind: SyncPage["kind"],
  historyDue = false,
): SyncPage => ({
  ...changes,
  cursor: encodeCursor(next),
  more:
    kind === "backfill" ||
    next.phase !== "incremental" ||
    next.live.pageToken !== null ||
    next.live.pending.length > 0 ||
    historyDue,
  kind,
  backfill: next.phase === "incremental" ? "done" : "running",
});

export const createSource = (
  { command, backfill, labels: labelNames }: GwsConfig,
  sleep: Sleep,
): Source => {
  const cli: Gws = { command, sleep };
  const listingPage = async (
    pass: Pass,
    labels: LabelIds,
    labelId: string | null,
    q: string,
    position: Listing,
  ) => {
    const list = await listThreads(cli, labelId, q, position.pageToken, LIST_SIZE, pass.signal);
    const fetched = new Set(position.fetched);
    const unfetched = (list.threads ?? []).map((t) => t.id).filter((id) => !fetched.has(id));
    const page = await fetchPage(cli, pass.emailAddress, labels, unfetched, pass.signal);
    for (const id of unfetched.slice(0, unfetched.length - page.rest.length)) fetched.add(id);
    const next: Listing = {
      pageToken: page.rest.length > 0 ? position.pageToken : (list.nextPageToken ?? null),
      fetched: [...fetched],
    };
    const changes: Changes = { upserts: page.upserts, deletions: page.deletions };
    return { changes, next, done: page.rest.length === 0 && list.nextPageToken === undefined };
  };

  const livePage = async (pass: Pass, labels: LabelIds, live: Live) => {
    if (live.pending.length > 0) {
      const page = await fetchPage(cli, pass.emailAddress, labels, live.pending, pass.signal);
      const changes: Changes = { upserts: page.upserts, deletions: page.deletions };
      return { changes, live: { ...live, pending: page.rest }, historyDue: true };
    }
    const startedAt = Effect.runSync(Clock.currentTimeMillis);
    let history: HistoryList;
    try {
      history = await listHistory(cli, live.historyId, live.pageToken, pass.signal);
    } catch (error) {
      if (isNotFound(error)) return null;
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
    const page = await fetchPage(cli, pass.emailAddress, labels, [...threads], pass.signal);
    const changes: Changes = {
      upserts: page.upserts.filter((item) => !deleted.has(item.externalId)),
      deletions: [...new Set([...deleted, ...page.deletions])],
    };
    const next: Live =
      history.nextPageToken === undefined
        ? {
            historyId: history.historyId,
            pageToken: null,
            watermark: startedAt,
            pending: page.rest,
          }
        : { ...live, pageToken: history.nextPageToken, pending: page.rest };
    return { changes, live: next, historyDue: false };
  };

  const step = async (pass: Pass, position: Cursor): Promise<SyncPage> => {
    const { labels } = position;
    const gap = (live: Live): Cursor => ({
      phase: "gap",
      labels,
      after: Math.floor(live.watermark / 1000) - GAP_SLACK_SECONDS,
      pageToken: null,
      fetched: [],
      live: {
        historyId: pass.historyId,
        pageToken: null,
        watermark: pass.recordedAt,
        pending: live.pending,
      },
    });
    switch (position.phase) {
      case "backfill": {
        if (position.turn === "live") {
          const live = await livePage(pass, labels, position.live);
          if (live === null) return step(pass, gap(position.live));
          return emit(live.changes, { ...position, live: live.live, turn: "backfill" }, "live");
        }
        const [label, ...later] = position.listing;
        const { changes, next, done } = await listingPage(pass, labels, label, backfill, position);
        const recent = position.live.watermark - HOLD_BACK_MS;
        const queued = new Set(position.live.pending);
        const pending = new Set(queued);
        const upserts = changes.upserts.filter((item) => {
          if (item.threadId === null) return true;
          if (!queued.has(item.threadId) && Date.parse(item.occurredAt) < recent) return true;
          pending.add(item.threadId);
          return false;
        });
        const live = { ...position.live, pending: [...pending] };
        const listing = done ? later : position.listing;
        return emit(
          { upserts, deletions: changes.deletions },
          Arr.isReadonlyArrayNonEmpty(listing)
            ? { ...position, listing, ...next, live, turn: "live" }
            : { phase: "incremental", labels, live },
          "backfill",
        );
      }
      case "gap": {
        const { changes, next, done } = await listingPage(
          pass,
          labels,
          null,
          `after:${position.after}`,
          position,
        );
        return emit(
          changes,
          done
            ? {
                phase: "backfill",
                labels,
                ...listingStart(labels),
                live: position.live,
                turn: "backfill",
              }
            : { ...position, ...next },
          "live",
        );
      }
      case "incremental": {
        const live = await livePage(pass, labels, position.live);
        if (live === null) return step(pass, gap(position.live));
        return emit(
          live.changes,
          { phase: "incremental", labels, live: live.live },
          "live",
          live.historyDue,
        );
      }
    }
  };

  const resume = (position: Cursor | null, labels: LabelIds, cold: Live): Cursor => {
    if (position === null) {
      return { phase: "backfill", labels, ...listingStart(labels), live: cold, turn: "backfill" };
    }
    if (sameLabels(position.labels, labels)) return position;
    if (position.phase === "gap") return { ...position, labels, pageToken: null, fetched: [] };
    return {
      phase: "backfill",
      labels,
      ...listingStart(labels),
      live: position.live,
      turn: "live",
    };
  };

  return {
    streams: async () => {
      const [profile, sendAs] = await Promise.all([getProfile(cli), listSendAs(cli)]);
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
      const recordedAt = Effect.runSync(Clock.currentTimeMillis);
      const [profile, labels] = await Promise.all([
        getProfile(cli, signal),
        resolveLabels(cli, labelNames, signal),
      ]);
      if (streamId !== profile.emailAddress) {
        throw new Error(`gws has no stream ${streamId}; the mailbox is ${profile.emailAddress}`);
      }
      const pass: Pass = {
        emailAddress: profile.emailAddress,
        historyId: profile.historyId,
        recordedAt,
        signal,
      };
      return step(
        pass,
        resume(position, labels, {
          historyId: profile.historyId,
          pageToken: null,
          watermark: recordedAt,
          pending: [],
        }),
      );
    },
  };
};

export const gws: SourcePlugin<GwsConfig> = {
  id: "gws",
  configSchema: Schema.toStandardSchemaV1(GwsConfig),
  create: (config) => createSource(config, abortableSleep),
};
