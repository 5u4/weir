import type { RawItem, SourcePlugin, SyncPage } from "@weir/contract/Source";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  type Command,
  GwsError,
  getMessage,
  getProfile,
  type HistoryList,
  listHistory,
  listMessages,
  listSendAs,
} from "./gws.ts";
import { toRawItem } from "./item.ts";

const GwsConfig = Schema.Struct({
  command: Schema.NonEmptyArray(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(["gws"] as const)),
  ),
  backfill: Schema.String,
});
export type GwsConfig = typeof GwsConfig.Type;

const Cursor = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      phase: Schema.Literal("backfill"),
      startHistoryId: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      phase: Schema.Literal("incremental"),
      historyId: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
    }),
  ]),
);
type Cursor = typeof Cursor.Type;
const encodeCursor = Schema.encodeSync(Cursor);
const decodeCursor = Schema.decodeUnknownSync(Cursor);

const PAGE_SIZE = 100;
const CONCURRENCY = 8;
const HIDDEN: Record<string, true> = { SPAM: true, TRASH: true };

const isNotFound = (error: unknown): error is GwsError =>
  error instanceof GwsError && error.code === 404;

const fetchMessages = async (command: Command, emailAddress: string, ids: string[]) => {
  const upserts: RawItem[] = [];
  const deletions: string[] = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(i, i + CONCURRENCY).map(async (id) => ({
        id,
        message: await getMessage(command, id).catch((error: unknown) => {
          if (isNotFound(error)) return null;
          throw error;
        }),
      })),
    );
    for (const { id, message } of batch) {
      if (message === null || message.labelIds?.some((label) => HIDDEN[label])) {
        deletions.push(id);
      } else {
        upserts.push(toRawItem(message, emailAddress));
      }
    }
  }
  return { upserts, deletions };
};

const create = ({ command, backfill }: GwsConfig) => {
  const backfillPage = async (
    emailAddress: string,
    startHistoryId: string,
    pageToken: string | null,
  ): Promise<SyncPage> => {
    const list = await listMessages(command, backfill, pageToken, PAGE_SIZE);
    const page = await fetchMessages(
      command,
      emailAddress,
      (list.messages ?? []).map((m) => m.id),
    );
    const next: Cursor =
      list.nextPageToken === undefined
        ? { phase: "incremental", historyId: startHistoryId, pageToken: null }
        : { phase: "backfill", startHistoryId, pageToken: list.nextPageToken };
    const more = next.phase === "backfill";
    return {
      ...page,
      cursor: encodeCursor(next),
      more,
      kind: "backfill",
      backfill: more ? "running" : "done",
    };
  };

  const incrementalPage = async (
    emailAddress: string,
    restartHistoryId: string,
    historyId: string,
    pageToken: string | null,
  ): Promise<SyncPage> => {
    let history: HistoryList;
    try {
      history = await listHistory(command, historyId, pageToken);
    } catch (error) {
      if (isNotFound(error)) return backfillPage(emailAddress, restartHistoryId, null);
      throw error;
    }
    const deleted = new Set<string>();
    const changed = new Set<string>();
    for (const record of history.history ?? []) {
      for (const { message } of record.messagesDeleted ?? []) deleted.add(message.id);
      for (const { message } of [
        ...(record.messagesAdded ?? []),
        ...(record.labelsAdded ?? []),
        ...(record.labelsRemoved ?? []),
      ]) {
        changed.add(message.id);
      }
    }
    const page = await fetchMessages(
      command,
      emailAddress,
      [...changed].filter((id) => !deleted.has(id)),
    );
    const next: Cursor =
      history.nextPageToken === undefined
        ? { phase: "incremental", historyId: history.historyId, pageToken: null }
        : { phase: "incremental", historyId, pageToken: history.nextPageToken };
    return {
      upserts: page.upserts,
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
    sync: async (streamId: string, cursor: string | null): Promise<SyncPage> => {
      const position = cursor === null ? null : decodeCursor(cursor);
      const profile = await getProfile(command);
      if (streamId !== profile.emailAddress) {
        throw new Error(`gws has no stream ${streamId}; the mailbox is ${profile.emailAddress}`);
      }
      if (position === null) return backfillPage(profile.emailAddress, profile.historyId, null);
      switch (position.phase) {
        case "backfill":
          return backfillPage(profile.emailAddress, position.startHistoryId, position.pageToken);
        case "incremental":
          return incrementalPage(
            profile.emailAddress,
            profile.historyId,
            position.historyId,
            position.pageToken,
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
