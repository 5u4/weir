import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { decode } from "@toon-format/toon";
import type { RawItem, SourcePlugin } from "@weir/contract/Source";
import * as Home from "@weir/daemon/Home";
import * as Http from "@weir/daemon/Http";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const axiMain = join(import.meta.dirname, "../src/main.ts");

const axi = (home: string, ...args: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([process.execPath, axiMain, ...args], {
      env: { ...process.env, WEIR_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode, output: decode(stdout) as Record<string, unknown> };
  });

const longBody = `${"word ".repeat(200)}END`;

const items: ReadonlyArray<RawItem> = [
  {
    externalId: "a1",
    threadId: "t1",
    containerId: "INBOX",
    containerName: "Inbox",
    occurredAt: "2026-10-20T09:00:00Z",
    title: "Quarterly invoice review",
    from: { name: "Ada", address: "ada@example.com" },
    body: longBody,
    bodyNew: longBody,
    link: null,
    raw: { labelIds: ["INBOX"] },
  },
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
    }),
  }),
};

const config = `[[source]]
id = "mail"
plugin = "fake"
sync_every = "1h"

[source.config]
mode = "test"

[[tag]]
name = "Finance"
match = { type = "regex", target = "/title", regex = "invoice" }
`;

const startDaemon = Effect.gen(function* () {
  const home = Home.make(mkdtempSync(join(tmpdir(), "weir-axi-")));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  const writeConfig = (body: string) => writeFileSync(home.config, `port = ${port}\n\n${body}`);
  writeConfig(config);
  yield* Layer.build(Http.layer(home, { fake: plugin }));
  for (let attempt = 0; attempt < 200; attempt++) {
    const { output } = yield* axi(home.root);
    if (JSON.stringify(output.sources).includes('"listing":"ok"')) break;
    yield* Effect.sleep(Duration.millis(25));
  }
  return { home, writeConfig };
});

describe("weir-axi", () => {
  it.live("home shows tags with Untagged and each source's stream", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      const { output, exitCode } = yield* axi(home.root);
      expect(exitCode).toBe(0);
      expect(output.tags).toEqual([
        { name: "Finance", ai: false, conversations: 1, unread: 0, open: 1 },
        { name: "Untagged", ai: false, conversations: 0, unread: 0, open: 0 },
      ]);
      expect(output.sources).toMatchObject([
        { id: "mail", stream: "me@example.com", listing: "ok", backfill: "done", error: null },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("search takes its filters before or after the query words", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      for (const args of [
        ["search", "quarterly", "invoice", "--tag", "Finance"],
        ["search", "--tag", "Finance", "quarterly", "invoice"],
      ]) {
        const { output } = yield* axi(home.root, ...args);
        expect(output.query).toBe("quarterly invoice");
        expect(output.conversations).toMatchObject([{ title: "Quarterly invoice review" }]);
      }
      const { output } = yield* axi(home.root, "search", "invoice", "--source", "elsewhere");
      expect(output.conversations).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("item truncates the body until --full and prints the raw object with --raw", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      const short = yield* axi(home.root, "item", "1");
      expect(short.output.body).not.toContain("END");
      expect(short.output.help).toContain("weir-axi item 1 --full");
      const full = yield* axi(home.root, "item", "1", "--full");
      expect(full.output.body).toBe(longBody);
      const raw = yield* axi(home.root, "item", "1", "--raw");
      expect(raw.output).toEqual({ seq: 1, raw: { labelIds: ["INBOX"] } });
    }).pipe(Effect.scoped),
  );

  it.live("reload reports the config file and path when the config is broken", () =>
    Effect.gen(function* () {
      const { home, writeConfig } = yield* startDaemon;
      writeConfig(config.replace('regex = "invoice"', 'regex = "("'));
      const { output, exitCode } = yield* axi(home.root, "reload");
      expect(exitCode).toBe(1);
      expect(output.file).toBe(home.config);
      expect(output.error).toContain('["tag"][0]["match"]');
      const status = yield* axi(home.root);
      expect(status.output.sync).toBe("stopped");
    }).pipe(Effect.scoped),
  );

  it.live("reaches the daemon when config.toml is not valid TOML", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      writeFileSync(home.config, "[[source]\n");
      const status = yield* axi(home.root);
      expect(status.exitCode).toBe(0);
      expect(status.output.weir).toBe(home.root);
      const found = yield* axi(home.root, "search", "invoice");
      expect(found.exitCode).toBe(0);
      expect(found.output.conversations).toMatchObject([{ title: "Quarterly invoice review" }]);
      const reloaded = yield* axi(home.root, "reload");
      expect(reloaded.exitCode).toBe(1);
      expect(reloaded.output.file).toBe(home.config);
      expect(reloaded.output.error).toContain("invalid TOML");
    }).pipe(Effect.scoped),
  );

  it.live("tells the agent when the daemon is not running", () =>
    Effect.gen(function* () {
      const home = Home.make(mkdtempSync(join(tmpdir(), "weir-axi-")));
      writeFileSync(home.config, "port = 1\n");
      const { output, exitCode } = yield* axi(home.root, "search", "invoice");
      expect(exitCode).toBe(1);
      expect(output.error).toBe(
        `weir daemon is not running (no ${home.daemon}); start it with weir-daemon`,
      );
    }),
  );

  it.live("names daemon.json when the daemon it points at is gone", () =>
    Effect.gen(function* () {
      const home = Home.make(mkdtempSync(join(tmpdir(), "weir-axi-")));
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = server.port;
      server.stop(true);
      writeFileSync(home.daemon, JSON.stringify({ port, pid: 1 }));
      const { output, exitCode } = yield* axi(home.root, "search", "invoice");
      expect(exitCode).toBe(1);
      expect(output.error).toContain(
        `cannot reach weir daemon at 127.0.0.1:${port} from ${home.daemon}`,
      );
    }),
  );
});
