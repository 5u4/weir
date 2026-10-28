#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { encode } from "@toon-format/toon";
import { DurationShorthand } from "@weir/contract/Config";
import { Api, defaultPort } from "@weir/daemon/Api";
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

const bodyLimit = 400;

class AxiError extends Schema.TaggedError<AxiError>()("AxiError", { message: Schema.String }) {}

const PortConfig = Schema.Struct({ port: Schema.optionalKey(Schema.Int) });

const daemon = Effect.gen(function* () {
  const home = yield* Home.fromEnv;
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(home.config).text(),
    catch: () => new AxiError({ message: `cannot read ${home.config}; set WEIR_HOME` }),
  });
  const parsed = yield* Effect.try({
    try: () => Bun.TOML.parse(text),
    catch: (cause) =>
      new AxiError({
        message: `invalid TOML in ${home.config}: ${cause instanceof Error ? cause.message : cause}`,
      }),
  });
  const { port = defaultPort } = yield* Schema.decodeUnknownEffect(PortConfig)(parsed).pipe(
    Effect.mapError(() => new AxiError({ message: `port in ${home.config} must be an integer` })),
  );
  return yield* HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` });
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

const home = Command.make("weir-axi", {}, () =>
  Effect.gen(function* () {
    const client = yield* daemon;
    const status = yield* client.status();
    yield* print({
      weir: status.home,
      config: status.config.path,
      sync: status.sync,
      ...(status.config.error === null ? {} : { config_error: status.config.error.message }),
      tags: [
        ...status.tags.map(({ name, ai, conversations, unread, open }) => ({
          name,
          ai,
          conversations,
          unread,
          open,
        })),
        { name: "Untagged", ai: false, ...status.untagged },
      ],
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
        "weir-axi search <query> [--tag <tag>] [--source <id>] [--from <who>] [--since 7d]",
        "weir-axi tag test [<name>]",
        "weir-axi reload",
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
            ? ["weir-axi search <fewer or shorter words>"]
            : [`weir-axi conv ${conversations[0].id}`],
      });
    }),
);

const conv = Command.make("conv", { id: Argument.Int("id") }, ({ id }) =>
  Effect.gen(function* () {
    const client = yield* daemon;
    const { items, ...conversation } = yield* client.conversation({ params: { id } });
    yield* print({
      conversation,
      items: items.map(({ seq, occurred_at, from, from_me, body_new }) => ({
        seq,
        occurred_at,
        from: `${from.name} <${from.address}>`,
        from_me,
        body: truncate(body_new, false),
      })),
      help: ["weir-axi item <seq> --full", "weir-axi item <seq> --raw"],
    });
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
        yield* print({ seq, raw: found.raw });
        return;
      }
      const body = truncate(found.body, full);
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
          ...(body === found.body ? [] : [`weir-axi item ${seq} --full`]),
          `weir-axi item ${seq} --raw`,
          `weir-axi conv ${found.conversation_id}`,
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
        help: ["weir-axi search <query> --tag <name>", "weir-axi reload"],
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
      help: ["weir-axi"],
    });
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
    item,
    Command.make("tag").pipe(Command.withSubcommands([tagTest])),
    reload,
  ]),
  Command.run({ version: "0.1.0" }),
  Effect.catchTags({
    ConfigInvalid: ({ message, file, issues }) => fail({ error: message, file, issues }),
    NotFound: ({ message }) => fail({ error: message }),
    AxiError: ({ message }) => fail({ error: message }),
    HttpClientError: ({ message }) =>
      fail({
        error: `weir daemon is not reachable: ${message}`,
        help: ["weir-daemon", "check port in $WEIR_HOME/config.toml"],
      }),
  }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain,
);
