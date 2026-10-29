import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { Api } from "@weir/daemon/Api";
import { plugins } from "@weir/daemon/Daemon";
import * as Home from "@weir/daemon/Home";
import * as Http from "@weir/daemon/Http";
import {
  configToml,
  deliver,
  expectedDigests,
  expectedTags,
  FIXTURE_NOW,
  seedMailbox,
  setNow,
} from "@weir/fixtures";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";

const searches: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["Northwind", ["Northwind migration: cutover plan and UAT sign-off"]],
  [
    "migrat",
    [
      "Northwind migration: cutover plan and UAT sign-off",
      "[ledgerline/billing-api] Enforce unique (tenant_id, idempotency_key) on invoices (PR #4821)",
      "[ledgerline/billing-api] Batched backfill for invoice_line_items (PR #4818)",
    ],
  ],
  ["idempotency backfill", ["The Pragmatic Ledger #212: idempotency keys are not enough"]],
  [
    "60",
    [
      "Robin, your weekend list: 30% off trail packs ends Sunday",
      "Mom's 60th: plan, dates and money",
    ],
  ],
];

const { values: flags } = parseArgs({ options: { serve: { type: "boolean", default: false } } });

const home = Home.make(mkdtempSync(join(tmpdir(), "weir-demo-")));
console.error(`weir demo: WEIR_HOME=${home.root}`);

const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portProbe.port;
portProbe.stop(true);
const AI_SINCE = expectedDigests.ai_since;
const mailbox = join(home.root, "mailbox");
const seeded = seedMailbox(mailbox, { until: AI_SINCE });
writeFileSync(home.config, `port = ${port}\n\n${configToml(mailbox)}`);

process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}:${process.env.PATH}`;

const millisOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
let fixedMillis = millisOf(AI_SINCE);
const liveClock = Clock.Clock.defaultValue();
const fixtureClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => fixedMillis,
  currentTimeMillis: Effect.sync(() => fixedMillis),
  currentTimeNanosUnsafe: () => BigInt(fixedMillis) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(fixedMillis) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: liveClock.monotonicTimeNanos,
  sleep: (duration) => liveClock.sleep(duration),
};

const Hits = Schema.Struct({ conversations: Schema.Int, items: Schema.Int });
const decodeSearch = Schema.decodeUnknownSync(
  Schema.Struct({ conversations: Schema.Array(Schema.Struct({ title: Schema.String })) }),
);
const decodeTagTest = Schema.decodeUnknownSync(
  Schema.Struct({
    tags: Schema.Array(Schema.Struct({ name: Schema.String, ...Hits.fields })),
    untagged: Hits,
    total: Hits,
  }),
);

const axi = (...args: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const proc = Bun.spawn(["weir-axi", ...args], {
      env: { ...process.env, WEIR_HOME: home.root },
      stdout: "pipe",
      stderr: "inherit",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0)
      throw new Error(`weir-axi ${args.join(" ")} exited ${exitCode}:\n${stdout}`);
    return decode(stdout);
  });

const pollUntil = <A, E, R>(
  what: string,
  probe: Effect.Effect<
    { readonly done: boolean; readonly pending: string; readonly value: A },
    E,
    R
  >,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const result = yield* probe;
      if (result.done) return result.value;
      if (attempt >= 1200)
        return yield* Effect.fail(`${what} did not settle within 60s; pending: ${result.pending}`);
      yield* Effect.sleep(Duration.millis(50));
    }
  });

const demo = Effect.gen(function* () {
  yield* Layer.build(Http.layer(home, plugins));
  const client = yield* HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` });

  const syncedAt = (iso: string) =>
    pollUntil(
      `sync at ${iso}`,
      Effect.map(client.status(), (status) => {
        const pending = status.sources.flatMap(({ id, listing, streams }) =>
          listing === "failed"
            ? []
            : listing === "pending"
              ? [`${id} listing`]
              : streams
                  .filter(
                    ({ last_sync_at }) =>
                      last_sync_at === null || millisOf(last_sync_at) !== millisOf(iso),
                  )
                  .map(({ name }) => `${id} (${name})`),
        );
        return { done: pending.length === 0, pending: pending.join(", "), value: status };
      }),
    );

  let status = yield* syncedAt(AI_SINCE);
  const failed = status.sources.filter(({ listing }) => listing !== "ok");
  if (failed.length > 0) return yield* Effect.fail(`first sync failed: ${JSON.stringify(failed)}`);

  const views = [
    ...Object.keys(expectedTags.tags).map((name) => ({ _tag: "Tag" as const, name })),
    { _tag: "Untagged" as const },
  ];
  const allConversations = Effect.gen(function* () {
    const byId = new Map<number, { readonly id: number; readonly last_seq: number }>();
    for (const view of views) {
      for (const row of (yield* client.conversations({ query: { view } })).conversations)
        byId.set(row.id, row);
    }
    return [...byId.values()];
  });
  const before = yield* allConversations;
  for (const { id, last_seq } of before)
    yield* client.read({ params: { id }, payload: { seq: last_seq } });

  const delivered = deliver(mailbox, seeded.pending);
  setNow(mailbox, FIXTURE_NOW);
  fixedMillis = millisOf(FIXTURE_NOW);
  yield* client.reload();
  status = yield* syncedAt(FIXTURE_NOW);
  status = yield* pollUntil(
    "digest queue",
    Effect.map(client.status(), (status) => {
      const digest = status.digest;
      const pending =
        digest === null
          ? "digest disabled"
          : [
              ...digest.running.map(
                ({ conversation_id, from_seq, to_seq }) =>
                  `running ${conversation_id} #${from_seq}-#${to_seq}`,
              ),
              ...(digest.waiting > 0 ? [`${digest.waiting} waiting`] : []),
            ].join(", ");
      return { done: pending === "", pending, value: status };
    }),
  );
  const lines = [
    `weir demo: temporary WEIR_HOME, fixture clock ${AI_SINCE} (${seeded.delivered} items, read), then ${FIXTURE_NOW} (${delivered.length} more, reload)`,
  ];
  const problems: Array<string> = [];

  for (const [query, expected] of searches) {
    const titles = decodeSearch(yield* axi("search", ...query.split(" "))).conversations.map(
      ({ title }) => title,
    );
    if (JSON.stringify(titles.toSorted()) !== JSON.stringify(expected.toSorted())) {
      problems.push(
        `search "${query}" returned ${JSON.stringify(titles)}, expected ${JSON.stringify(expected)}`,
      );
    }
    lines.push(
      `search "${query}": ${titles.length} hit(s)`,
      ...titles.map((title) => `  ${title}`),
    );
  }

  const tagTest = decodeTagTest(yield* axi("tag", "test"));
  const actual = Object.fromEntries(
    tagTest.tags.map(({ name, conversations, items }) => [name, { conversations, items }]),
  );
  const checks: ReadonlyArray<readonly [string, unknown, unknown]> = [
    ["tags", actual, expectedTags.tags],
    ["Untagged", tagTest.untagged, expectedTags.untagged],
    [
      "total",
      tagTest.total,
      { conversations: expectedTags.conversations, items: expectedTags.items },
    ],
  ];
  for (const [label, got, want] of checks) {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(
        `tag test ${label} ${JSON.stringify(got)} != expected-tags.json ${JSON.stringify(want)}`,
      );
    }
  }
  lines.push(
    ...status.sources.flatMap(({ id, streams }) =>
      streams.map(({ name, last_sync_at }) => `synced ${id} (${name}) at ${last_sync_at}`),
    ),
    `tag test total: ${tagTest.total.conversations} conversations, ${tagTest.total.items} items`,
    `tag test (conversations/items): ${[
      ...tagTest.tags.map(({ name, conversations, items }) => `${name} ${conversations}/${items}`),
      `Untagged ${tagTest.untagged.conversations}/${tagTest.untagged.items}`,
    ].join(", ")}`,
  );

  const aiTags = status.tags.filter(({ ai_since }) => ai_since !== null);
  for (const { name, ai_since } of status.tags) {
    const ai = name === "Me" || name === "On-call";
    if (
      ai !== (ai_since !== null) ||
      (ai_since !== null && millisOf(ai_since) !== millisOf(AI_SINCE))
    )
      problems.push(`tag ${name} ai_since ${ai_since}, expected ${ai ? AI_SINCE : null}`);
  }

  const key = (conversation: string, first: string, last: string) =>
    `${conversation} | ${new Date(millisOf(first)).toISOString()} .. ${new Date(millisOf(last)).toISOString()}`;
  const want = new Map(
    expectedDigests.digests.map((digest) => [
      key(digest.conversation, digest.first_occurred_at, digest.last_occurred_at),
      digest,
    ]),
  );
  const aiNames = new Set(aiTags.map(({ name }) => name));
  const got = new Set<string>();
  for (const { id } of yield* allConversations) {
    const conversation = yield* client.conversation({ params: { id } });
    const isAi = conversation.tags.some((tag) => aiNames.has(tag));
    for (const digest of conversation.digests) {
      if (digest.trigger !== "auto") continue;
      const range = conversation.items.filter(
        ({ seq }) => digest.from_seq <= seq && seq <= digest.to_seq,
      );
      const first = range[0];
      const last = range.at(-1);
      if (first === undefined || last === undefined) {
        problems.push(
          `"${conversation.title}" auto digest #${digest.from_seq}-#${digest.to_seq} covers no items`,
        );
        continue;
      }
      const k = key(conversation.title, first.occurred_at, last.occurred_at);
      got.add(k);
      const expected = want.get(k);
      if (!isAi) problems.push(`"${conversation.title}" has no AI tag but has auto digest ${k}`);
      if (millisOf(first.occurred_at) < millisOf(AI_SINCE))
        problems.push(
          `"${conversation.title}" auto digest starts before ai_since at ${first.occurred_at}`,
        );
      if (expected === undefined) {
        problems.push(
          `"${conversation.title}" auto digest ${k} (${range.length} items) is not in expected-digests.json`,
        );
      } else if (range.length !== expected.items || digest.ai_profile !== expected.ai_profile) {
        problems.push(
          `"${conversation.title}" auto digest ${k}: ${range.length} items by ${digest.ai_profile}, expected ${expected.items} by ${expected.ai_profile}`,
        );
      }
    }
  }
  for (const [k, expected] of want) {
    if (!got.has(k))
      problems.push(
        `"${expected.conversation}" expected auto digest ${k} (${expected.items} items) is missing`,
      );
  }
  lines.push(
    `ai_since ${aiTags.map(({ name }) => name).join(", ")}: ${AI_SINCE}`,
    `auto digests: ${got.size}`,
    ...[...got].map((k) => `  ${k}`),
  );

  if (problems.length > 0) return yield* Effect.fail(problems.join("\n"));
  lines.push("ok: search, tag test and digests match the fixtures");
  console.log(lines.join("\n"));
  if (flags.serve) {
    console.log(`weir demo: serving http://127.0.0.1:${port}/ until Ctrl-C`);
    return yield* Effect.never;
  }
}).pipe(
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(Clock.Clock, fixtureClock),
  Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)])),
);

const interrupt = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => interrupt.abort());

const exit = await Effect.runPromiseExit(demo, { signal: interrupt.signal });
rmSync(home.root, { recursive: true, force: true });
if (exit._tag === "Failure") {
  if (Cause.hasInterruptsOnly(exit.cause)) process.exit(130);
  console.error(`weir demo failed:\n${String(exit.cause)}`);
  process.exit(1);
}
