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

const cliMain = join(import.meta.dirname, "../src/main.ts");

const weir = (home: string, ...args: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const proc = Bun.spawn([process.execPath, cliMain, ...args], {
      env: { ...process.env, WEIR_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode, output: decode(stdout) as Record<string, unknown> };
  });

const longBody = `${"word ".repeat(200)}END`;
const receipt = `<html><head><style>td{color:#600}</style></head><body><table width="600"><tr><td>Total</td><td>CAD 42</td></tr></table></body></html>`;

const items: ReadonlyArray<RawItem> = [
  {
    externalId: "a1",
    threadId: "t1",
    containerId: "INBOX",
    containerName: "Inbox",
    occurredAt: "2026-10-20T09:00:00Z",
    title: "Quarterly invoice review",
    from: { name: "Ada", address: "ada@example.com" },
    fromVerified: false,
    format: "markdown",
    body: longBody,
    bodyNew: longBody,
    link: null,
    raw: { labelIds: ["INBOX"] },
  },
  {
    externalId: "a2",
    threadId: "t1",
    containerId: "INBOX",
    containerName: "Inbox",
    occurredAt: "2026-10-20T10:00:00Z",
    title: "Your invoice receipt",
    from: { name: "Billing", address: "billing@example.com" },
    fromVerified: false,
    format: "html",
    body: receipt,
    bodyNew: receipt,
    link: null,
    raw: { labelIds: [] },
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
      kind: cursor === null ? "backfill" : "live",
      backfill: "done",
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
ai = true
match = { type = "regex", target = "/title", regex = "invoice" }
`;

const startDaemon = Effect.gen(function* () {
  const home = Home.make(mkdtempSync(join(tmpdir(), "weir-cli-")));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  const writeConfig = (body: string) => writeFileSync(home.config, `port = ${port}\n\n${body}`);
  writeConfig(config);
  yield* Layer.build(Http.layer(home, { fake: plugin }));
  for (let attempt = 0; attempt < 200; attempt++) {
    const { output } = yield* weir(home.root);
    if (JSON.stringify(output.sources).includes('"listing":"ok"')) break;
    yield* Effect.sleep(Duration.millis(25));
  }
  return { home, writeConfig };
});

describe("weir", () => {
  it.live("home shows tags with Untagged, the AI scopes and each source's stream", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      const { output, exitCode } = yield* weir(home.root);
      expect(exitCode).toBe(0);
      expect(output.tags).toEqual([
        { name: "Finance", conversations: 1, unread: 0, open: 1 },
        { name: "Untagged", conversations: 0, unread: 0, open: 0 },
      ]);
      expect(output.ai).toMatchObject([{ kind: "tag", name: "Finance", conversations: 1 }]);
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
        const { output } = yield* weir(home.root, ...args);
        expect(output.query).toBe("quarterly invoice");
        expect(output.conversations).toMatchObject([{ title: "Quarterly invoice review" }]);
      }
      const { output } = yield* weir(home.root, "search", "invoice", "--source", "elsewhere");
      expect(output.conversations).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("item truncates the body until --full and --raw prints pointers a rule matches", () =>
    Effect.gen(function* () {
      const { home, writeConfig } = yield* startDaemon;
      const short = yield* weir(home.root, "item", "1");
      expect(short.output.body).not.toContain("END");
      expect(short.output.help).toContain("weir item 1 --full");
      const full = yield* weir(home.root, "item", "1", "--full");
      expect(full.output.body).toBe(longBody);
      const raw = yield* weir(home.root, "item", "1", "--raw");
      expect(raw.output.raw).toEqual({ labelIds: ["INBOX"] });
      writeConfig(`${config}
[[tag]]
name = "Inbox"
match = { type = "eq", target = "/raw/labelIds/0", is = "INBOX" }
`);
      const tested = yield* weir(home.root, "tag", "test", "Inbox");
      expect(tested.output.tags).toEqual([{ name: "Inbox", conversations: 1, items: 1 }]);
    }).pipe(Effect.scoped),
  );

  it.live("item and conv print an HTML email as its visible text", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      const item = yield* weir(home.root, "item", "2");
      expect(item.output).toMatchObject({ item: { conversation: 1 }, body: "Total CAD 42" });
      const conv = yield* weir(home.root, "conv", "1");
      expect(conv.output).toMatchObject({
        items: [{ seq: 1 }, { seq: 2, body: "Total CAD 42" }],
      });
    }).pipe(Effect.scoped),
  );

  it.live("reload reports the config file and path when the config is broken", () =>
    Effect.gen(function* () {
      const { home, writeConfig } = yield* startDaemon;
      writeConfig(config.replace('regex = "invoice"', 'regex = "("'));
      const { output, exitCode } = yield* weir(home.root, "reload");
      expect(exitCode).toBe(1);
      expect(output.file).toBe(home.config);
      expect(output.error).toContain('["tag"][0]["match"]');
      const status = yield* weir(home.root);
      expect(status.output.sync).toBe("stopped");
    }).pipe(Effect.scoped),
  );

  it.live("reaches the daemon when config.toml is not valid TOML", () =>
    Effect.gen(function* () {
      const { home } = yield* startDaemon;
      writeFileSync(home.config, "[[source]\n");
      const status = yield* weir(home.root);
      expect(status.exitCode).toBe(0);
      expect(status.output.weir).toBe(home.root);
      const found = yield* weir(home.root, "search", "invoice");
      expect(found.exitCode).toBe(0);
      expect(found.output.conversations).toMatchObject([{ title: "Quarterly invoice review" }]);
      const reloaded = yield* weir(home.root, "reload");
      expect(reloaded.exitCode).toBe(1);
      expect(reloaded.output.file).toBe(home.config);
      expect(reloaded.output.error).toContain("invalid TOML");
    }).pipe(Effect.scoped),
  );

  it.live("tells the agent when the daemon is not running", () =>
    Effect.gen(function* () {
      const home = Home.make(mkdtempSync(join(tmpdir(), "weir-cli-")));
      writeFileSync(home.config, "port = 1\n");
      const { output, exitCode } = yield* weir(home.root, "search", "invoice");
      expect(exitCode).toBe(1);
      expect(output.error).toBe(
        `weir daemon is not running (no ${home.daemon}); start it with weir start`,
      );
    }),
  );

  it.live("names daemon.json when the daemon it points at is gone", () =>
    Effect.gen(function* () {
      const home = Home.make(mkdtempSync(join(tmpdir(), "weir-cli-")));
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = server.port;
      server.stop(true);
      writeFileSync(home.daemon, JSON.stringify({ port, pid: 1, started: "then" }));
      const { output, exitCode } = yield* weir(home.root, "search", "invoice");
      expect(exitCode).toBe(1);
      expect(output.error).toContain(
        `cannot reach weir daemon at 127.0.0.1:${port} from ${home.daemon}`,
      );
    }),
  );

  it.live("treats a daemon.json port outside 1..65535 as not valid", () =>
    Effect.gen(function* () {
      const home = Home.make(mkdtempSync(join(tmpdir(), "weir-cli-")));
      for (const port of [65536, 0, -1]) {
        writeFileSync(home.daemon, JSON.stringify({ port, pid: 1, started: "then" }));
        const { output, exitCode } = yield* weir(home.root, "search", "invoice");
        expect(exitCode).toBe(1);
        expect(output.error).toBe(`${home.daemon} is not valid; run weir start`);
      }
    }),
  );
});
