import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { Api } from "@weir/daemon/Api";
import { plugins } from "@weir/daemon/Daemon";
import * as Home from "@weir/daemon/Home";
import * as Http from "@weir/daemon/Http";
import { configToml, expectedTags, FIXTURE_NOW } from "@weir/fixtures";
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
writeFileSync(home.config, `port = ${port}\n\n${configToml()}`);

process.env.PATH = `${join(import.meta.dirname, "../node_modules/.bin")}:${process.env.PATH}`;

const fixedMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(FIXTURE_NOW));
const liveClock = Clock.Clock.defaultValue();
const fixtureClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => fixedMillis,
  currentTimeMillis: Effect.succeed(fixedMillis),
  currentTimeNanosUnsafe: () => BigInt(fixedMillis) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(fixedMillis) * 1_000_000n),
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

const demo = Effect.gen(function* () {
  yield* Layer.build(Http.layer(home, plugins));
  const client = yield* HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` });
  let status = yield* client.status();
  for (let attempt = 0; attempt < 600; attempt++) {
    if (status.sources.every(({ listing }) => listing !== "pending")) break;
    yield* Effect.sleep(Duration.millis(50));
    status = yield* client.status();
  }
  const failed = status.sources.filter(({ listing }) => listing !== "ok");
  if (failed.length > 0) return yield* Effect.fail(`first sync failed: ${JSON.stringify(failed)}`);

  const lines = [`weir demo: temporary WEIR_HOME, fixture clock ${FIXTURE_NOW}`];
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

  if (problems.length > 0) return yield* Effect.fail(problems.join("\n"));
  lines.push("ok: search and tag test match the fixtures");
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
