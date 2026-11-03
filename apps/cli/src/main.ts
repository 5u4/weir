#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { encode } from "@toon-format/toon";
import { DurationShorthand, untagged } from "@weir/contract/Config";
import { Api } from "@weir/daemon/Api";
import * as Home from "@weir/daemon/Home";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Lifecycle from "./Lifecycle.ts";

const bodyLimit = 400;

const noIdleTimeout: BunFetchRequestInit = { timeout: false };

class CliError extends Schema.TaggedError<CliError>()("CliError", { message: Schema.String }) {}

const daemon = Effect.gen(function* () {
  const home = yield* Home.fromEnv;
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(home.daemon).text(),
    catch: () =>
      new CliError({
        message: `weir daemon is not running (no ${home.daemon}); start it with weir start`,
      }),
  });
  const { port } = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Home.DaemonFile))(
    text,
  ).pipe(
    Effect.mapError(() => new CliError({ message: `${home.daemon} is not valid; run weir start` })),
  );
  return yield* HttpApiClient.make(Api, { baseUrl: Lifecycle.url(port) });
});

interface SourceRow {
  readonly id: string;
  readonly stream: string | null;
  readonly listing: string;
  readonly backfill: string | null;
  readonly last_sync: string | null;
  readonly error: string | null;
}

const print = (value: unknown) => Console.log(encode(value));

const truncate = (text: string, full: boolean) =>
  full || text.length <= bodyLimit ? text : `${text.slice(0, bodyLimit)}…`;

const home = Command.make("weir", {}, () =>
  Effect.gen(function* () {
    const client = yield* daemon;
    const status = yield* client.status();
    yield* print({
      weir: status.home,
      config: status.config.path,
      sync: status.sync,
      ...(status.config.error === null ? {} : { config_error: status.config.error.message }),
      tags: [...status.tags, { name: untagged, ...status.untagged }],
      ai: status.ai,
      sources: status.sources.flatMap(
        ({ id, listing, error, streams }): Array<SourceRow> =>
          streams.length === 0
            ? [{ id, stream: null, listing, backfill: null, last_sync: null, error }]
            : streams.map((stream) => ({
                id,
                stream: stream.name,
                listing,
                backfill: stream.backfill,
                last_sync: stream.last_sync_at,
                error: error ?? stream.last_error,
              })),
      ),
      help: [
        "weir search <query> [--tag <tag>] [--source <id>] [--from <who>] [--since 7d]",
        "weir tag test [<name>]",
        "weir group test [<name>]",
        "weir reload",
      ],
    });
  }),
);

const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(Argument.atLeast(1)),
    tag: Flag.String("tag").pipe(Flag.optional),
    source: Flag.String("source").pipe(Flag.optional),
    from: Flag.String("from").pipe(Flag.optional),
    since: Flag.String("since").pipe(Flag.withSchema(DurationShorthand), Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.withDefault(20)),
  },
  ({ query, tag, source, from, since, limit }) =>
    Effect.gen(function* () {
      const client = yield* daemon;
      const q = query.join(" ");
      const { conversations } = yield* client.search({
        query: {
          q,
          limit,
          ...Option.match(tag, { onNone: () => ({}), onSome: (tag) => ({ tag }) }),
          ...Option.match(source, { onNone: () => ({}), onSome: (source) => ({ source }) }),
          ...Option.match(from, { onNone: () => ({}), onSome: (from) => ({ from }) }),
          ...Option.match(since, { onNone: () => ({}), onSome: (since) => ({ since }) }),
        },
      });
      yield* print({
        query: q,
        conversations,
        help:
          conversations[0] === undefined
            ? ["weir search <fewer or shorter words>"]
            : [`weir conv ${conversations[0].id}`],
      });
    }),
);

const conv = Command.make("conv", { id: Argument.Int("id") }, ({ id }) =>
  Effect.gen(function* () {
    const client = yield* daemon;
    const { items, digests, ...conversation } = yield* client.conversation({ params: { id } });
    yield* print({
      conversation,
      digests,
      items: items
        .filter(
          ({ seq }) => !digests.some(({ from_seq, to_seq }) => from_seq <= seq && seq <= to_seq),
        )
        .map(({ seq, occurred_at, from, from_me, text_new }) => ({
          seq,
          occurred_at,
          from: `${from.name} <${from.address}>`,
          from_me,
          body: truncate(text_new, false),
        })),
      help: [
        "weir item <seq> --full",
        "weir item <seq> --raw",
        `weir digest ${id} [--from <seq> | --up-to <seq>]`,
      ],
    });
  }),
);

const digest = Command.make(
  "digest",
  {
    id: Argument.Int("conversation"),
    from: Flag.Int("from").pipe(Flag.optional),
    upTo: Flag.Int("up-to").pipe(Flag.optional),
  },
  ({ id, from, upTo }) =>
    Effect.gen(function* () {
      if (Option.isSome(from) && Option.isSome(upTo)) {
        return yield* new CliError({ message: "--from and --up-to are exclusive; pass one" });
      }
      const client = yield* daemon;
      const { digests } = yield* client
        .digest({
          params: { id },
          payload: {
            ...Option.match(from, { onNone: () => ({}), onSome: (from) => ({ from }) }),
            ...Option.match(upTo, { onNone: () => ({}), onSome: (up_to) => ({ up_to }) }),
          },
        })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, noIdleTimeout));
      yield* print({ digests, help: [`weir conv ${id}`] });
    }),
);

const item = Command.make(
  "item",
  {
    seq: Argument.Int("seq"),
    full: Flag.Boolean("full").pipe(Flag.withDefault(false)),
    raw: Flag.Boolean("raw").pipe(Flag.withDefault(false)),
  },
  ({ seq, full, raw }) =>
    Effect.gen(function* () {
      const client = yield* daemon;
      const found = yield* client.item({ params: { seq } });
      if (raw) {
        yield* print(found.input);
        return;
      }
      const body = truncate(found.text, full);
      yield* print({
        item: {
          seq,
          conversation: found.conversation_id,
          title: found.title,
          from: `${found.from.name} <${found.from.address}>`,
          from_me: found.from_me,
          occurred_at: found.occurred_at,
          container: found.container_name,
          link: found.link,
          deleted_at: found.deleted_at,
        },
        body,
        help: [
          ...(body === found.text ? [] : [`weir item ${seq} --full`]),
          `weir item ${seq} --raw`,
          `weir conv ${found.conversation_id}`,
        ],
      });
    }),
);

const tagTest = Command.make(
  "test",
  { name: Argument.String("name").pipe(Argument.optional) },
  ({ name }) =>
    Effect.gen(function* () {
      const client = yield* daemon;
      const result = yield* client.tagTest({
        query: Option.match(name, { onNone: () => ({}), onSome: (name) => ({ name }) }),
      });
      yield* print({
        config: result.config,
        tags: result.tags.map(({ name, conversations, items }) => ({ name, conversations, items })),
        untagged: result.untagged,
        total: result.total,
        samples: result.tags.flatMap(({ name, samples }) =>
          samples.map(({ id, title }) => ({ tag: name, id, title })),
        ),
        help: ["weir search <query> --tag <name>", "weir reload"],
      });
    }),
);

const groupTest = Command.make(
  "test",
  { name: Argument.String("name").pipe(Argument.optional) },
  ({ name }) =>
    Effect.gen(function* () {
      const client = yield* daemon;
      const result = yield* client.groupTest({
        query: Option.match(name, { onNone: () => ({}), onSome: (name) => ({ name }) }),
      });
      yield* print({
        config: result.config,
        groups: result.groups.map(({ name, conversations, items, moves }) => ({
          name,
          conversations,
          items,
          moves,
        })),
        moves: result.moves,
        samples: result.groups.flatMap(({ name, samples }) =>
          samples.map(({ id, title }) => ({ group: name, id, title })),
        ),
        help: ["weir conv <id>", "weir reload"],
      });
    }),
);

const reload = Command.make("reload", {}, () =>
  Effect.gen(function* () {
    const client = yield* daemon;
    const reloaded = yield* client.reload();
    yield* print({
      reloaded: reloaded.loaded_at,
      sources: reloaded.sources,
      tags: reloaded.tags,
      help: ["weir"],
    });
  }),
);

const start = Command.make("start", {}, () =>
  Effect.gen(function* () {
    const home = yield* Home.fromEnv;
    const { daemon, started } = yield* Lifecycle.start(home);
    yield* print({
      daemon: started ? "started" : "running",
      pid: daemon.pid,
      url: Lifecycle.url(daemon.port),
      log: home.log,
      help: ["weir", "weir stop"],
    });
  }),
);

const stop = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const stopped = yield* Lifecycle.stop(yield* Home.fromEnv);
    yield* print(
      Option.match(stopped, {
        onNone: () => ({ daemon: "not running", help: ["weir start"] }),
        onSome: ({ pid }) => ({ daemon: "stopped", pid, help: ["weir start"] }),
      }),
    );
  }),
);

const fail = (value: unknown) =>
  print(value).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

home.pipe(
  Command.withSubcommands([
    search,
    conv,
    digest,
    item,
    Command.make("tag").pipe(Command.withSubcommands([tagTest])),
    Command.make("group").pipe(Command.withSubcommands([groupTest])),
    reload,
    start,
    stop,
  ]),
  Command.run({ version: "0.1.0" }),
  Effect.catchTags({
    ConfigInvalid: ({ message, file, issues }) => fail({ error: message, file, issues }),
    NotFound: ({ message }) => fail({ error: message }),
    CliError: ({ message }) => fail({ error: message }),
    DigestConflict: ({ message }) => fail({ error: message }),
    DigestFailed: ({ error, log_path }) =>
      fail({ error: log_path === null ? error : `${error}; log: ${log_path}`, log: log_path }),
    DigestInterrupted: ({ message }) => fail({ error: message }),
    DaemonExited: ({ message, log }) => fail({ error: message, log, help: ["weir start"] }),
    DaemonSilent: ({ message, log }) => fail({ error: message, log, help: ["weir stop"] }),
    DaemonTimedOut: ({ message, log }) => fail({ error: message, log, help: ["weir start"] }),
    PlatformError: ({ message }) => fail({ error: message }),
    HttpClientError: ({ message, request }) =>
      Effect.gen(function* () {
        const { daemon } = yield* Home.fromEnv;
        yield* fail({
          error: `cannot reach weir daemon at ${new URL(request.url).host} from ${daemon}: ${message}`,
          help: ["weir start"],
        });
      }),
  }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain,
);
