import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { type Config, untagged } from "@weir/contract/Config";
import * as Database from "@weir/store/Database";
import * as Read from "@weir/store/Read";
import {
  ConversationId,
  type ConversationRow,
  type ListedConversationRow,
  Seq,
} from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import { match, ruleInput } from "@weir/sync/Match";
import type * as Scheduler from "@weir/sync/Scheduler";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import {
  Api,
  type ConversationSummary,
  type Counts,
  NotFound,
  type Row,
  type Status,
  type TagTest,
  type View,
} from "./Api.ts";
import * as ConfigFile from "./ConfigFile.ts";
import { Daemon, layer as daemonLayer, type State } from "./Daemon.ts";
import { DaemonFile, type WeirHome } from "./Home.ts";
import { isLoopbackRequest } from "./Loopback.ts";

const tagTestBatch = 200;
const tagTestSamples = 3;

const summary = (row: ConversationRow): ConversationSummary => ({
  id: row.id,
  source: row.sourceId,
  title: row.title,
  last_at: DateTime.formatIso(row.lastAt),
});

const status = Effect.fnUntraced(function* (home: WeirHome, state: State) {
  const streams = yield* Read.streams();
  const aiSince = new Map(
    (yield* Read.tagStates()).map(({ name, aiSince }) => [name, DateTime.formatIso(aiSince)]),
  );
  const counts = yield* Read.tagCounts();
  const countsOf = (tag: string | null) => {
    const row = counts.find((count) => count.tag === tag);
    return {
      conversations: row?.conversations ?? 0,
      unread: row?.unread ?? 0,
      open: row?.open ?? 0,
    };
  };
  return {
    home: home.root,
    config: {
      path: home.config,
      loaded_at: DateTime.formatIso(state.loadedAt),
      error:
        state.configError === null
          ? null
          : {
              file: state.configError.file,
              message: state.configError.message,
              issues: state.configError.issues,
            },
    },
    sync: state.configError === null ? "running" : "stopped",
    sources: state.config.source.map(({ id, plugin }) => {
      const listing = state.listings.get(id) ?? { state: "pending" };
      return {
        id,
        plugin,
        listing: listing.state,
        error: listing.state === "failed" ? listing.error : null,
        streams: streams
          .filter(({ sourceId }) => sourceId === id)
          .map((stream) => ({
            name: stream.name,
            kind: stream.kind,
            last_sync_at: stream.lastSyncAt === null ? null : DateTime.formatIso(stream.lastSyncAt),
            last_error: stream.lastError,
            backfill: stream.backfilledAt === null ? "running" : "done",
          })),
      };
    }),
    tags: state.config.tag.map(({ name, ai }) => ({
      name,
      ai,
      ai_since: aiSince.get(name) ?? null,
      ...countsOf(name),
    })),
    untagged: countsOf(null),
  } satisfies Status;
});

const tagTest = Effect.fnUntraced(function* (file: string, name: string | undefined) {
  const config = yield* ConfigFile.read(file);
  const tested = name === undefined ? config.tag : config.tag.filter((tag) => tag.name === name);
  if (tested.length === 0 && name !== undefined) {
    return yield* new NotFound({ message: `no tag "${name}" in ${file}` });
  }
  const hits = config.tag.map((tag) => ({
    tag,
    conversations: 0,
    items: 0,
    samples: [] as Array<ConversationSummary>,
  }));
  const untagged = { conversations: 0, items: 0 };
  const total = { conversations: 0, items: 0 };
  const conversations = yield* Read.search({ query: "" });
  for (const batch of Arr.chunksOf(conversations, tagTestBatch)) {
    const items = yield* Read.liveItems({ conversationIds: batch.map(({ id }) => id) });
    for (const conversation of batch) {
      const inputs = items
        .filter(({ conversationId }) => conversationId === conversation.id)
        .map(ruleInput);
      total.conversations += 1;
      total.items += inputs.length;
      let tagged = false;
      for (const hit of hits) {
        const matched = inputs.filter((input) => match(hit.tag.match, input)).length;
        if (matched === 0) continue;
        tagged = true;
        hit.conversations += 1;
        hit.items += matched;
        if (hit.samples.length < tagTestSamples) hit.samples.push(summary(conversation));
      }
      if (!tagged) {
        untagged.conversations += 1;
        untagged.items += inputs.length;
      }
    }
  }
  return {
    config: file,
    tags: hits
      .filter(({ tag }) => tested.includes(tag))
      .map(({ tag, conversations, items, samples }) => ({
        name: tag.name,
        conversations,
        items,
        samples,
      })),
    untagged,
    total,
  } satisfies TagTest;
});

const row = (conversation: ListedConversationRow): Row => ({
  id: conversation.id,
  source: conversation.sourceId,
  title: conversation.title,
  tags: conversation.tags,
  first_at: DateTime.formatIso(conversation.firstAt),
  last_at: DateTime.formatIso(conversation.lastAt),
  last_seq: conversation.lastSeq,
  seen_seq: conversation.seenSeq,
  cleared_seq: conversation.clearedSeq,
  muted: conversation.muted,
  state: conversation.state,
  new: conversation.newItems,
  items: conversation.items,
  participants: conversation.participants,
});

const sendersPerView = 3;

const listed = Effect.fnUntraced(function* (id: number) {
  const found = yield* Read.conversation(ConversationId.make(id));
  if (Option.isNone(found)) return yield* new NotFound({ message: `no conversation ${id}` });
  return found.value;
});

const knownView = Effect.fnUntraced(function* (config: Config, view: View) {
  if (view._tag === "Tag" && !config.tag.some(({ name }) => name === view.name)) {
    return yield* new NotFound({ message: `no tag "${view.name}"` });
  }
});

const counts = Effect.fnUntraced(function* (config: Config) {
  const tagCounts = yield* Read.tagCounts();
  const senders = yield* Read.unreadSenders(sendersPerView);
  const totals = yield* Read.stateTotals();
  const summaryOf = (tag: string | null) => {
    const count = tagCounts.find((candidate) => candidate.tag === tag);
    return {
      unread: count?.unread ?? 0,
      open: count?.open ?? 0,
      senders: senders
        .filter((sender) => sender.tag === tag)
        .map(({ name, address }) => ({ name, address })),
    };
  };
  return {
    unread: totals.unread,
    tags: config.tag.map(({ name }) => ({ name, ...summaryOf(name) })),
    untagged: summaryOf(null),
    cleared: totals.cleared,
  } satisfies Counts;
});

const changeState = Effect.fnUntraced(function* (id: number, change: Write.StateChange) {
  yield* listed(id);
  yield* Write.changeState([ConversationId.make(id)], change);
  return row(yield* listed(id));
});

const dieOnStoreError = <A, R>(
  effect: Effect.Effect<A, NotFound | SqlError.SqlError | Schema.SchemaError, R>,
) => effect.pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die));

const viewHandlers = HttpApiBuilder.group(
  Api,
  "view",
  Effect.fnUntraced(function* (handlers) {
    const daemon = yield* Daemon;
    const withSql = Effect.provideService(SqlClient.SqlClient, yield* SqlClient.SqlClient);
    return handlers.handleAll({
      conversations: ({ query: { view } }) =>
        Effect.gen(function* () {
          yield* knownView((yield* daemon.state).config, view);
          const seq = yield* Read.maxSeq();
          const conversations = yield* Read.conversations(view);
          return { seq, conversations: conversations.map(row) };
        }).pipe(withSql, dieOnStoreError),
      counts: () =>
        daemon.state.pipe(
          Effect.flatMap(({ config }) => counts(config)),
          withSql,
          Effect.orDie,
        ),
    });
  }),
);

const stateHandlers = HttpApiBuilder.group(
  Api,
  "state",
  Effect.fnUntraced(function* (handlers) {
    const daemon = yield* Daemon;
    const withSql = Effect.provideService(SqlClient.SqlClient, yield* SqlClient.SqlClient);
    return handlers.handleAll({
      read: ({ params: { id }, payload: { seq } }) =>
        changeState(id, { _tag: "Read", seq: Seq.make(seq) }).pipe(withSql, dieOnStoreError),
      unread: ({ params: { id }, payload: { seq } }) =>
        changeState(
          id,
          seq === undefined ? { _tag: "Unread" } : { _tag: "Unread", seq: Seq.make(seq) },
        ).pipe(withSql, dieOnStoreError),
      done: ({ params: { id }, payload: { seq } }) =>
        changeState(id, { _tag: "Done", seq: Seq.make(seq) }).pipe(withSql, dieOnStoreError),
      mute: ({ params: { id } }) =>
        changeState(id, { _tag: "Mute" }).pipe(withSql, dieOnStoreError),
      restore: ({ params: { id } }) =>
        changeState(id, { _tag: "Restore" }).pipe(withSql, dieOnStoreError),
      clear: ({ payload: { view, seq } }) =>
        Effect.gen(function* () {
          yield* knownView((yield* daemon.state).config, view);
          return { cleared: yield* Write.clear(view, Seq.make(seq)) };
        }).pipe(withSql, dieOnStoreError),
    });
  }),
);

const weirHandlers = HttpApiBuilder.group(
  Api,
  "weir",
  Effect.fnUntraced(function* (handlers) {
    const daemon = yield* Daemon;
    const sql = yield* SqlClient.SqlClient;
    const withSql = Effect.provideService(SqlClient.SqlClient, sql);
    return handlers.handleAll({
      status: () =>
        daemon.state.pipe(
          Effect.flatMap((state) => status(daemon.home, state)),
          withSql,
          Effect.orDie,
        ),
      search: ({ query: { q, tag, since, ...filters } }) =>
        Effect.gen(function* () {
          const rows = yield* Read.search({
            query: q,
            ...filters,
            ...(tag === undefined
              ? {}
              : {
                  tag:
                    tag === untagged
                      ? { _tag: "Untagged" as const }
                      : { _tag: "Tag" as const, name: tag },
                }),
            ...(since === undefined
              ? {}
              : { since: DateTime.subtractDuration(yield* DateTime.now, since) }),
          });
          return { conversations: rows.map(summary) };
        }).pipe(withSql, Effect.orDie),
      conversation: ({ params: { id } }) =>
        Effect.gen(function* () {
          const state = yield* listed(id);
          const detail = yield* Read.getConversation(state.id);
          if (Option.isNone(detail)) {
            return yield* new NotFound({ message: `no conversation ${id}` });
          }
          const { conversation, items, tags } = detail.value;
          const digests = yield* Read.digests(conversation.id);
          return {
            ...summary(conversation),
            first_at: DateTime.formatIso(conversation.firstAt),
            tags,
            state: {
              seen_seq: state.seenSeq,
              cleared_seq: state.clearedSeq,
              muted: state.muted,
              state: state.state,
            },
            items: items.map((item) => ({
              seq: item.seq,
              occurred_at: DateTime.formatIso(item.occurredAt),
              from: { name: item.fromName, address: item.fromAddress },
              from_me: item.fromMe,
              title: item.title,
              body_new: item.bodyNew,
            })),
            digests: digests.map((digest) => ({
              id: digest.id,
              conversation_id: digest.conversationId,
              from_seq: digest.fromSeq,
              to_seq: digest.toSeq,
              headline: digest.headline,
              topics: digest.topics,
              trigger: digest.trigger,
              ai_profile: digest.aiProfile,
              created_at: DateTime.formatIso(digest.createdAt),
            })),
          };
        }).pipe(withSql, dieOnStoreError),
      item: ({ params: { seq } }) =>
        Effect.gen(function* () {
          const found = yield* Read.getItem(Seq.make(seq)).pipe(withSql, Effect.orDie);
          if (Option.isNone(found)) return yield* new NotFound({ message: `no item ${seq}` });
          const item = found.value;
          return {
            seq: item.seq,
            conversation_id: item.conversationId,
            container_name: item.containerName,
            occurred_at: DateTime.formatIso(item.occurredAt),
            title: item.title,
            from: { name: item.fromName, address: item.fromAddress },
            from_me: item.fromMe,
            link: item.link,
            body: item.body,
            body_new: item.bodyNew,
            raw: item.raw,
            deleted_at: item.deletedAt === null ? null : DateTime.formatIso(item.deletedAt),
          };
        }),
      tagTest: ({ query: { name } }) =>
        tagTest(daemon.home.config, name).pipe(
          withSql,
          Effect.catchTag(["SqlError", "SchemaError"], Effect.die),
        ),
      reload: () =>
        daemon.reload.pipe(
          Effect.map((state) => ({
            loaded_at: DateTime.formatIso(state.loadedAt),
            sources: state.config.source.map(({ id }) => id),
            tags: state.config.tag.map(({ name }) => name),
          })),
        ),
    });
  }),
);

const handlers = Layer.mergeAll(weirHandlers, viewHandlers, stateHandlers);

const advertise = (home: WeirHome) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { address } = yield* HttpServer.HttpServer;
      if (address._tag === "UnixPathAddress") {
        return yield* Effect.die(new Error(`weir daemon listens on ${address.path}, not TCP`));
      }
      const temp = `${home.daemon}.${process.pid}.tmp`;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          writeFileSync(
            temp,
            JSON.stringify({ port: address.port, pid: process.pid } satisfies DaemonFile),
          );
          renameSync(temp, home.daemon);
        }),
        () =>
          Effect.try(() => readFileSync(home.daemon, "utf8")).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(DaemonFile))),
            Effect.flatMap(({ pid }) =>
              pid === process.pid ? Effect.sync(() => rmSync(home.daemon)) : Effect.void,
            ),
            Effect.ignore,
          ),
      );
    }),
  );

const loopbackOnly = HttpRouter.middleware(
  Effect.gen(function* () {
    const { port } = yield* Daemon;
    return (httpEffect) =>
      Effect.flatMap(HttpServerRequest.HttpServerRequest, ({ headers }) =>
        isLoopbackRequest(headers.host, headers.origin, port)
          ? httpEffect
          : Effect.succeed(HttpServerResponse.empty({ status: 403 })),
      );
  }),
  { global: true },
);

export const layer = (home: WeirHome, registry: Scheduler.PluginRegistry) =>
  advertise(home).pipe(
    Layer.provide(
      HttpRouter.serve(
        Layer.mergeAll(HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers)), loopbackOnly),
        {
          disableLogger: true,
          disableListenLog: true,
        },
      ),
    ),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const { port } = yield* Daemon;
          return BunHttpServer.layer({ hostname: "127.0.0.1", port });
        }),
      ),
    ),
    Layer.provideMerge(daemonLayer(home, registry)),
    Layer.provide(Database.layer(home.db)),
  );
