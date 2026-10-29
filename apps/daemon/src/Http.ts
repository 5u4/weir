import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { type Config, untagged } from "@weir/contract/Config";
import type { Digest } from "@weir/contract/Digest";
import type * as Digester from "@weir/digest/Digester";
import { backlog, type Gap, gaps } from "@weir/digest/Range";
import * as Database from "@weir/store/Database";
import * as Read from "@weir/store/Read";
import {
  ConversationId,
  type ConversationRow,
  DigestId,
  type DigestRow,
  type DigestRunRow,
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
  DigestConflict,
  DigestFailed,
  type DigestGap,
  DigestInterrupted,
  type DigestRun,
  type Line,
  NotFound,
  type Row,
  type SearchResult,
  type Status,
  type TagTest,
  type View,
} from "./Api.ts";
import * as ConfigFile from "./ConfigFile.ts";
import { Daemon, layer as daemonLayer, type State } from "./Daemon.ts";
import { DaemonFile, type WeirHome } from "./Home.ts";
import { isLoopbackRequest } from "./Loopback.ts";
import { plainText } from "./Markdown.ts";
import { segments, senderLabel, termPattern } from "./Match.ts";
import * as Web from "./Web.ts";

const tagTestBatch = 200;
const tagTestSamples = 3;
const lastRunHours = 24;

const summary = (row: ConversationRow): ConversationSummary => ({
  id: row.id,
  source: row.sourceId,
  title: row.title,
  last_at: DateTime.formatIso(row.lastAt),
});

const digestJson = (digest: DigestRow): Digest => ({
  id: digest.id,
  conversation_id: digest.conversationId,
  from_seq: digest.fromSeq,
  to_seq: digest.toSeq,
  headline: digest.headline,
  topics: digest.topics,
  trigger: digest.trigger,
  ai_profile: digest.aiProfile,
  created_at: DateTime.formatIso(digest.createdAt),
});

const gapJson = (gap: Gap): DigestGap => ({
  from_seq: gap.fromSeq,
  to_seq: gap.toSeq,
  items: gap.items,
  run_items: gap.runItems,
});

const runJson = (run: DigestRunRow): DigestRun => ({
  conversation_id: run.conversationId,
  from_seq: run.fromSeq,
  to_seq: run.toSeq,
  trigger: run.trigger,
  at: DateTime.formatIso(run.startedAt),
  ms: run.ms,
  ok: run.ok,
  error: run.error,
  log_path: run.logPath,
});

const status = Effect.fnUntraced(function* (
  home: WeirHome,
  state: State,
  digester: Option.Option<Digester.Digester>,
) {
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
  const queue = Option.isNone(digester) ? { running: [], queued: [] } : yield* digester.value.queue;
  const titles = yield* Read.conversationTitles(
    [...queue.running, ...queue.queued].map(({ conversationId }) => conversationId),
  );
  const digestJob = ({ conversationId, range, trigger }: Digester.Job) => ({
    conversation_id: conversationId,
    from_seq: range.fromSeq,
    to_seq: range.toSeq,
    trigger,
    title: titles.get(conversationId) ?? "",
  });
  const lastRun = yield* Read.digestRunsSince(
    DateTime.subtract(yield* DateTime.now, { hours: lastRunHours }),
  );
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
            items: stream.items,
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
    digest:
      state.config.digest === undefined
        ? null
        : {
            ai: state.config.digest.ai,
            threshold: state.config.digest.threshold,
            running: queue.running.map(digestJob),
            queued: queue.queued.map(digestJob),
            last_run: Option.getOrNull(
              Option.map(lastRun, ({ at, written, failed, avgMs }) => ({
                at: DateTime.formatIso(at),
                written,
                failed,
                avg_ms: avgMs,
              })),
            ),
          },
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

const previewLength = 160;

const preview = ({
  coveringHeadline,
  lastBodyNew,
  lastFromName,
  lastFromAddress,
  lastFromMe,
}: ListedConversationRow) => {
  if (coveringHeadline !== null) return coveringHeadline;
  const plain = lastBodyNew
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#>*_`|~]+/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const text = [...plain].slice(0, previewLength).join("");
  const named = lastFromName.trim() === "" ? (lastFromAddress.split("@")[0] ?? "") : lastFromName;
  const who = lastFromMe ? "Me" : (named.trim().split(/\s+/u)[0] ?? "");
  return `${who}: ${text === "" ? "(no text)" : text}`;
};

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
  from: conversation.from,
  preview: preview(conversation),
  senders: conversation.senders,
});

const hitLinesPerConversation = 3;
const bodySnippetLength = 120;
const headlineSnippetLength = 60;

const snippet = (text: string, matchAt: number, length: number) => {
  if (text.length <= length) return text;
  const start = Math.max(0, Math.min(matchAt - length / 3, text.length - length));
  const end = start + length;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

const hitLines = (
  items: ReadonlyArray<Read.HitItem>,
  digests: ReadonlyArray<DigestRow>,
  pattern: RegExp,
): Array<Line> => {
  const live = new Set<number>(items.map(({ seq }) => seq));
  const coveredByTopic = new Set<number>();
  const topicLines = digests.toReversed().flatMap((digest) =>
    digest.topics
      .filter(({ title, body }) => title.search(pattern) !== -1 || body.search(pattern) !== -1)
      .map((topic): Line => {
        for (const seq of topic.seqs) coveredByTopic.add(seq);
        return {
          field: "topic",
          seq: topic.seqs.findLast((seq) => live.has(seq)) ?? null,
          digest_id: digest.id,
          title: segments(topic.title, pattern),
          text: segments(topic.body, pattern),
        };
      }),
  );
  const itemLines: Array<Line> = [];
  for (const item of items.toSorted((left, right) => right.seq - left.seq)) {
    if (itemLines.length === hitLinesPerConversation) break;
    if (coveredByTopic.has(item.seq)) continue;
    const fields = [
      [
        "body",
        item.bodyNew.search(pattern) === -1
          ? ""
          : plainText(item.bodyNew).replace(/\s+/gu, " ").trim(),
      ],
      ["from", senderLabel(item.fromName, item.fromAddress)],
      ["source", item.streamName],
    ] as const;
    for (const [field, text] of fields) {
      const matchAt = text.search(pattern);
      if (matchAt === -1) continue;
      itemLines.push({
        field,
        seq: item.seq,
        digest_id: null,
        title: null,
        text: segments(
          field === "body" ? snippet(text, matchAt, bodySnippetLength) : text,
          pattern,
        ),
      });
      break;
    }
  }
  const headlineLines = digests.toReversed().flatMap((digest): Array<Line> => {
    const matchAt = digest.headline.search(pattern);
    if (matchAt === -1) return [];
    return [
      {
        field: "headline",
        seq: null,
        digest_id: digest.id,
        title: null,
        text: segments(snippet(digest.headline, matchAt, headlineSnippetLength), pattern),
      },
    ];
  });
  return [...topicLines, ...itemLines]
    .toSorted((left, right) => (right.seq ?? 0) - (left.seq ?? 0))
    .concat(headlineLines)
    .slice(0, hitLinesPerConversation);
};

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
  const changed = yield* Write.changeState([ConversationId.make(id)], change);
  return { row: row(yield* listed(id)), changed };
});

const dieOnStoreError = <A, R>(
  effect: Effect.Effect<A, NotFound | SqlError.SqlError | Schema.SchemaError, R>,
) => effect.pipe(Effect.catchTag(["SqlError", "SchemaError"], Effect.die));

const viewHandlers = HttpApiBuilder.group(
  Api,
  "view",
  Effect.fnUntraced(function* (handlers) {
    const daemon = yield* Daemon;
    const sql = yield* SqlClient.SqlClient;
    const withSql = Effect.provideService(SqlClient.SqlClient, sql);
    return handlers.handleAll({
      conversations: ({ query: { view } }) =>
        Effect.gen(function* () {
          yield* knownView((yield* daemon.state).config, view);
          const { seq, conversations } = yield* sql.withTransaction(
            Effect.all({ seq: Read.maxSeq(), conversations: Read.conversations(view) }),
          );
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
    const announce = (ids: ReadonlyArray<number>) =>
      ids.length === 0 ? Effect.void : daemon.events.publish({ type: "state", ids });
    const respond = (id: number, change: Write.StateChange) =>
      changeState(id, change).pipe(
        withSql,
        dieOnStoreError,
        Effect.tap(({ changed }) => announce(changed)),
        Effect.map(({ row }) => row),
      );
    return handlers.handleAll({
      read: ({ params: { id }, payload: { seq } }) =>
        respond(id, { _tag: "Read", seq: Seq.make(seq) }),
      unread: ({ params: { id }, payload: { seq } }) =>
        respond(
          id,
          seq === undefined ? { _tag: "Unread" } : { _tag: "Unread", seq: Seq.make(seq) },
        ),
      done: ({ params: { id }, payload: { seq } }) =>
        respond(id, { _tag: "Done", seq: Seq.make(seq) }),
      mute: ({ params: { id } }) => respond(id, { _tag: "Mute" }),
      restore: ({ params: { id } }) => respond(id, { _tag: "Restore" }),
      clear: ({ payload: { view, seq } }) =>
        Effect.gen(function* () {
          yield* knownView((yield* daemon.state).config, view);
          return yield* Write.clear(view, Seq.make(seq));
        }).pipe(
          withSql,
          dieOnStoreError,
          Effect.tap(({ changed }) => announce(changed)),
          Effect.map(({ cleared }) => ({ cleared })),
        ),
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
        Effect.gen(function* () {
          return yield* status(daemon.home, yield* daemon.state, yield* daemon.digester);
        }).pipe(withSql, Effect.orDie),
      search: ({ query: { q, tag, since, ...filters } }) =>
        Effect.gen(function* () {
          const found = yield* Read.search({
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
          const ids = found.map(({ id }) => id);
          const rows = new Map(
            (yield* Read.conversations({ _tag: "Ids", ids })).map((listed) => [listed.id, listed]),
          );
          const pattern = termPattern(q);
          const items = Map.groupBy(
            pattern === null ? [] : yield* Read.hitItems(ids),
            ({ conversationId }) => conversationId,
          );
          const digests = Map.groupBy(
            pattern === null ? [] : yield* Read.digests(ids),
            ({ conversationId }) => conversationId,
          );
          return {
            conversations: found.flatMap(({ id }) => {
              const listed = rows.get(id);
              if (listed === undefined) return [];
              return [
                {
                  ...row(listed),
                  hits:
                    pattern === null
                      ? []
                      : hitLines(items.get(id) ?? [], digests.get(id) ?? [], pattern),
                },
              ];
            }),
          } satisfies SearchResult;
        }).pipe(withSql, Effect.orDie),
      conversation: ({ params: { id } }) =>
        Effect.gen(function* () {
          const state = yield* listed(id);
          const detail = yield* Read.getConversation(state.id);
          if (Option.isNone(detail)) {
            return yield* new NotFound({ message: `no conversation ${id}` });
          }
          const { conversation, items, tags } = detail.value;
          const digests = yield* Read.digests([conversation.id]);
          const { config } = yield* daemon.state;
          const since = yield* Read.aiSince(conversation.id);
          const lastRun = yield* Read.lastDigestRun(conversation.id);
          const lite = yield* Read.itemsLite(conversation.id);
          const open = yield* Read.openTarget(conversation.id);
          const ranges =
            config.digest === undefined ? null : gaps(lite, digests, config.digest.max_input);
          return {
            ...summary(conversation),
            first_at: DateTime.formatIso(conversation.firstAt),
            tags,
            open: Option.getOrNull(open),
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
            digests: digests.map(digestJson),
            digest: {
              backlog:
                config.digest === undefined || Option.isNone(since)
                  ? null
                  : {
                      chars: backlog(lite, digests, since.value).chars,
                      threshold: config.digest.threshold,
                    },
              earlier:
                ranges === null
                  ? null
                  : ranges.earlier.map((earlier) => ({
                      before_digest: earlier.beforeDigest,
                      ...gapJson(earlier),
                    })),
              now: ranges === null || ranges.now === null ? null : gapJson(ranges.now),
              last_failure: Option.getOrNull(
                Option.map(
                  Option.filter(lastRun, ({ ok }) => !ok),
                  runJson,
                ),
              ),
            },
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

const digestHandlers = HttpApiBuilder.group(
  Api,
  "digest",
  Effect.fnUntraced(function* (handlers) {
    const daemon = yield* Daemon;
    const run = (
      digest: (
        digester: Digester.Digester,
      ) => Effect.Effect<ReadonlyArray<DigestRow>, Digester.ManualError>,
    ) =>
      Effect.gen(function* () {
        const current = yield* daemon.digester;
        if (Option.isNone(current)) {
          const { configError } = yield* daemon.state;
          return yield* new DigestConflict({
            message:
              configError === null
                ? `no [digest] section in ${daemon.home.config}`
                : `digests are stopped until ${configError.file} loads; fix it and reload`,
          });
        }
        return { digests: (yield* digest(current.value)).map(digestJson) };
      }).pipe(
        Effect.catchTags({
          DigestNotFound: ({ message }) => Effect.fail(new NotFound({ message })),
          DigestRejected: ({ message }) => Effect.fail(new DigestConflict({ message })),
          DigestRunFailed: ({ error, logPath }) =>
            Effect.fail(new DigestFailed({ error, log_path: logPath })),
          DigestInterrupted: ({ message }) => Effect.fail(new DigestInterrupted({ message })),
        }),
      );
    return handlers.handleAll({
      digest: ({ params: { id }, payload: { from, up_to } }) =>
        run((digester) =>
          digester.manual(
            ConversationId.make(id),
            from !== undefined
              ? { _tag: "From", seq: Seq.make(from) }
              : up_to !== undefined
                ? { _tag: "UpTo", seq: Seq.make(up_to) }
                : { _tag: "Now" },
          ),
        ),
      redo: ({ params: { id } }) => run((digester) => digester.redo(DigestId.make(id))),
    });
  }),
);

const eventsHandlers = HttpApiBuilder.group(
  Api,
  "events",
  Effect.fnUntraced(function* (handlers) {
    const { events } = yield* Daemon;
    return handlers.handle("events", () => events.respond);
  }),
);

const handlers = Layer.mergeAll(
  weirHandlers,
  viewHandlers,
  stateHandlers,
  digestHandlers,
  eventsHandlers,
);

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
      const { events } = yield* Daemon;
      yield* Effect.addFinalizer(() => events.shutdown);
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

export const layer = (
  home: WeirHome,
  registry: Scheduler.PluginRegistry,
  webDist: string = Web.defaultDist,
) =>
  advertise(home).pipe(
    Layer.provide(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers)),
          Web.layer(webDist),
          loopbackOnly,
        ),
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
          return BunHttpServer.layer({ hostname: "127.0.0.1", port, idleTimeout: 0 });
        }),
      ),
    ),
    Layer.provideMerge(daemonLayer(home, registry)),
    Layer.provide(Database.layer(home.db)),
  );
