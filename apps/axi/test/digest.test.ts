import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { decode } from "@toon-format/toon";
import type { RawItem, SourcePlugin } from "@weir/contract/Source";
import * as Home from "@weir/daemon/Home";
import * as Http from "@weir/daemon/Http";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const axiMain = join(import.meta.dirname, "../src/main.ts");
const fakeAi = join(import.meta.dirname, "../node_modules/.bin/fake-ai");

interface DigestRow {
  readonly id: number;
  readonly from_seq: number;
  readonly to_seq: number;
  readonly trigger: string;
  readonly headline: string;
}

interface Output {
  readonly error?: string;
  readonly log?: string;
  readonly digests?: ReadonlyArray<DigestRow>;
  readonly items?: ReadonlyArray<{ readonly seq: number }>;
  readonly conversations?: ReadonlyArray<{ readonly id: number }>;
}

const spawnAxi = (home: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([process.execPath, axiMain, ...args], {
      env: { ...process.env, WEIR_HOME: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { exitCode, output: decode(stdout) as Output };
  });

const message = (title: string, externalId: string, minute: number): RawItem => ({
  externalId,
  threadId: title,
  containerId: "INBOX",
  containerName: "Inbox",
  occurredAt: `2026-10-20T09:${String(minute).padStart(2, "0")}:00Z`,
  title,
  from: { name: "Ada", address: "ada@example.com" },
  body: `note ${externalId}`,
  bodyNew: `note ${externalId}`,
  link: null,
  raw: {},
});

const items: ReadonlyArray<RawItem> = [
  message("Quarterly invoice", "q1", 1),
  message("Quarterly invoice", "q2", 2),
  message("Quarterly invoice", "q3", 3),
  message("Quarterly invoice", "q4", 4),
  message("Weekly list", "w1", 5),
];

const plugin: SourcePlugin<unknown> = {
  id: "fake",
  configSchema: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.String)),
  create: () => ({
    streams: async () => [
      { id: "me@example.com", kind: "message", name: "me@example.com", me: [], openLabel: "Open" },
    ],
    sync: async (_streamId, cursor) => ({
      upserts: cursor === null ? items : [],
      deletions: [],
      cursor: "done",
      more: false,
      kind: cursor === null ? "backfill" : "live",
      backfill: "done",
    }),
  }),
};

const configFor = (capture: string, args: ReadonlyArray<string>) => `[[source]]
id = "mail"
plugin = "fake"
sync_every = "1h"

[source.config]
mode = "test"

[ai.fake]
command = ${JSON.stringify([fakeAi, "--capture", capture, ...args])}
timeout = "20s"
concurrency = 1

[digest]
ai = "fake"
threshold = 1000
max_input = 24000
context = 6000
`;

const start = (args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const home = Home.make(mkdtempSync(join(tmpdir(), "weir-axi-digest-")));
    const capture = join(home.root, "capture.jsonl");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = server.port;
    server.stop(true);
    const configure = (next: ReadonlyArray<string>) =>
      writeFileSync(home.config, `port = ${port}\n\n${configFor(capture, next)}`);
    configure(args);
    yield* Layer.build(Http.layer(home, { fake: plugin }));
    const axi = (...argv: ReadonlyArray<string>) => spawnAxi(home.root, argv);
    const conversationOf = (query: string) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          const { output } = yield* axi("search", query);
          const id = output.conversations?.[0]?.id;
          if (id !== undefined) return id;
          yield* Effect.sleep(Duration.millis(25));
        }
        throw new Error(`no conversation for ${query}`);
      });
    const invoice = yield* conversationOf("quarterly");
    const weekly = yield* conversationOf("weekly");
    const [s1, s2, s3, s4] = ((yield* axi("conv", String(invoice))).output.items ?? []).map(
      ({ seq }) => seq,
    );
    const [w1] = ((yield* axi("conv", String(weekly))).output.items ?? []).map(({ seq }) => seq);
    if ([s1, s2, s3, s4, w1].includes(undefined)) throw new Error("expected 5 items");
    return {
      home,
      capture,
      configure,
      axi,
      invoice,
      weekly,
      seqs: [s1, s2, s3, s4, w1] as [number, number, number, number, number],
    };
  });

const ranges = (digests: ReadonlyArray<DigestRow> | undefined) =>
  (digests ?? []).map(({ from_seq, to_seq, trigger }) => [from_seq, to_seq, trigger]);

describe("weir-axi digest", () => {
  it.live("a1: digest now prints the written digest and conv shows it", () =>
    Effect.gen(function* () {
      const { axi, weekly, seqs } = yield* start();
      const w1 = seqs[4];
      const written = yield* axi("digest", String(weekly));
      expect(written.exitCode).toBe(0);
      expect(ranges(written.output.digests)).toEqual([[w1, w1, "manual"]]);
      expect(written.output.digests?.[0]?.headline).not.toBe("");
      const shown = yield* axi("conv", String(weekly));
      expect(shown.output.digests?.map(({ id }) => id)).toEqual(
        written.output.digests?.map(({ id }) => id),
      );
    }).pipe(Effect.scoped),
  );

  it.live("a2: --from digests from that item to the end", () =>
    Effect.gen(function* () {
      const { axi, invoice, seqs } = yield* start();
      const { exitCode, output } = yield* axi("digest", String(invoice), "--from", String(seqs[2]));
      expect(exitCode).toBe(0);
      expect(ranges(output.digests)).toEqual([[seqs[2], seqs[3], "manual"]]);
    }).pipe(Effect.scoped),
  );

  it.live("a3: --up-to digests earlier items ending at that item", () =>
    Effect.gen(function* () {
      const { axi, invoice, seqs } = yield* start();
      const { exitCode, output } = yield* axi(
        "digest",
        String(invoice),
        "--up-to",
        String(seqs[1]),
      );
      expect(exitCode).toBe(0);
      expect(ranges(output.digests)).toEqual([[seqs[0], seqs[1], "manual"]]);
    }).pipe(Effect.scoped),
  );

  it.live("a4: --from with --up-to is an error and digests nothing", () =>
    Effect.gen(function* () {
      const { axi, invoice, seqs, capture } = yield* start();
      const both = yield* axi(
        "digest",
        String(invoice),
        "--from",
        String(seqs[2]),
        "--up-to",
        String(seqs[3]),
      );
      expect(both.exitCode).toBe(1);
      expect(both.output.error).toBe("--from and --up-to are exclusive; pass one");
      expect(existsSync(capture)).toBe(false);
      expect((yield* axi("conv", String(invoice))).output.digests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("a5: an unknown conversation (404) and nothing to digest (409) are errors", () =>
    Effect.gen(function* () {
      const { axi, weekly } = yield* start();
      const unknown = yield* axi("digest", "999999");
      expect(unknown.exitCode).toBe(1);
      expect(unknown.output.error).toContain("999999");
      expect((yield* axi("digest", String(weekly))).exitCode).toBe(0);
      const empty = yield* axi("digest", String(weekly));
      expect(empty.exitCode).toBe(1);
      expect(empty.output.error).toBe("nothing after the last digest");
    }).pipe(Effect.scoped),
  );

  it.live("a6: an AI that never answers validly is a 502 error naming the log", () =>
    Effect.gen(function* () {
      const { axi, weekly } = yield* start(["--invalid", "always"]);
      const { exitCode, output } = yield* axi("digest", String(weekly));
      expect(exitCode).toBe(1);
      const log = output.log ?? "";
      expect(existsSync(log)).toBe(true);
      expect(output.error).toContain(log);
    }).pipe(Effect.scoped),
  );

  it.live("a7: conv lists the digests and only the originals no digest covers", () =>
    Effect.gen(function* () {
      const { axi, invoice, seqs } = yield* start();
      const [s1, s2, s3, s4] = seqs;
      yield* axi("digest", String(invoice), "--up-to", String(s2));
      yield* axi("digest", String(invoice), "--from", String(s4));
      const { exitCode, output } = yield* axi("conv", String(invoice));
      expect(exitCode).toBe(0);
      expect(ranges(output.digests)).toEqual([
        [s1, s2, "manual"],
        [s4, s4, "manual"],
      ]);
      expect(output.items?.map(({ seq }) => seq)).toEqual([s3]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a reload during a held digest is a 503 DigestInterrupted error",
    () =>
      Effect.gen(function* () {
        const { axi, weekly, capture, configure } = yield* start(["--delay", "10000"]);
        const held = yield* Effect.forkChild(axi("digest", String(weekly)));
        for (let attempt = 0; attempt < 400 && !existsSync(capture); attempt++) {
          yield* Effect.sleep(Duration.millis(25));
        }
        expect(readFileSync(capture, "utf8")).not.toBe("");
        configure([]);
        expect((yield* axi("reload")).exitCode).toBe(0);
        const { exitCode, output } = yield* Fiber.join(held);
        expect(exitCode).toBe(1);
        expect(output.error).toBe("the digest was interrupted by a reload or shutdown; try again");
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "a held digest outlives the client's default idle timeout",
    () =>
      Effect.gen(function* () {
        const { home, weekly, seqs } = yield* start(["--delay", "10000"]);
        const { exitCode, output } = yield* spawnAxi(home.root, ["digest", String(weekly)], {
          BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1",
        });
        expect(exitCode).toBe(0);
        expect(ranges(output.digests)).toEqual([[seqs[4], seqs[4], "manual"]]);
      }).pipe(Effect.scoped),
    30_000,
  );
});
