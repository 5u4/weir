import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as Database from "@weir/store/Database";
import * as Read from "@weir/store/Read";
import { ConversationId, type ConversationRow, Seq } from "@weir/store/Rows";
import { match, ruleInput } from "@weir/sync/Match";
import type * as Scheduler from "@weir/sync/Scheduler";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { Api, type ConversationSummary, NotFound, type Status, type TagTest } from "./Api.ts";
import * as ConfigFile from "./ConfigFile.ts";
import { Daemon, layer as daemonLayer, type State } from "./Daemon.ts";
import type { WeirHome } from "./Home.ts";

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

const handlers = HttpApiBuilder.group(
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
      search: ({ query: { q, since, ...filters } }) =>
        Effect.gen(function* () {
          const rows = yield* Read.search({
            query: q,
            ...filters,
            ...(since === undefined
              ? {}
              : { since: DateTime.subtractDuration(yield* DateTime.now, since) }),
          });
          return { conversations: rows.map(summary) };
        }).pipe(withSql, Effect.orDie),
      conversation: ({ params: { id } }) =>
        Effect.gen(function* () {
          const detail = yield* Read.getConversation(ConversationId.make(id)).pipe(
            withSql,
            Effect.orDie,
          );
          if (Option.isNone(detail)) {
            return yield* new NotFound({ message: `no conversation ${id}` });
          }
          const { conversation, items, tags } = detail.value;
          return {
            ...summary(conversation),
            first_at: DateTime.formatIso(conversation.firstAt),
            tags,
            items: items.map((item) => ({
              seq: item.seq,
              occurred_at: DateTime.formatIso(item.occurredAt),
              from: { name: item.fromName, address: item.fromAddress },
              from_me: item.fromMe,
              title: item.title,
              body_new: item.bodyNew,
            })),
          };
        }),
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

export const layer = (home: WeirHome, registry: Scheduler.PluginRegistry) =>
  HttpRouter.serve(HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers)), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
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
