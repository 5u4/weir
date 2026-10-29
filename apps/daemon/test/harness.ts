import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestInput } from "@weir/contract/Digest";
import type { RawItem, Source, SourcePlugin, StreamDescriptor } from "@weir/contract/Source";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Schema from "effect/Schema";
import { Api } from "../src/Api.ts";
import * as Home from "../src/Home.ts";

export const freePort = () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
};

export const makeHome = (configBody: string) => {
  const home = Home.make(mkdtempSync(join(tmpdir(), "weir-daemon-")));
  const port = freePort();
  const writeConfig = (body: string) => writeFileSync(home.config, `port = ${port}\n\n${body}`);
  writeConfig(configBody);
  return { home, port, writeConfig };
};

export const apiClient = (port: number) =>
  HttpApiClient.make(Api, { baseUrl: `http://127.0.0.1:${port}` }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

export const rawRequest = (
  port: number,
  request: { method: string; path: string; headers: Record<string, string> },
) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1").setEncoding("utf8");
        let text = "";
        socket.on("data", (chunk: string) => {
          text += chunk;
        });
        socket.on("error", reject);
        socket.on("end", () => {
          const [head = "", body = ""] = text.split("\r\n\r\n");
          resolve({ status: Number(head.split(" ")[1]), body });
        });
        const headers = Object.entries({
          ...request.headers,
          "Content-Length": "0",
          Connection: "close",
        }).map(([name, value]) => `${name}: ${value}\r\n`);
        socket.write(`${request.method} ${request.path} HTTP/1.1\r\n${headers.join("")}\r\n`);
      }),
  );

export const adjustableClock = (iso: string) =>
  Effect.gen(function* () {
    const live = yield* Clock.Clock;
    let millis = DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.sync(() => millis),
      currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) => live.sleep(duration),
    };
    return {
      clock,
      set: (next: string) =>
        Effect.sync(() => {
          millis = DateTime.toEpochMillis(DateTime.makeUnsafe(next));
        }),
    };
  });

export const eventually = <A, E, R>(check: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    let value = yield* check;
    for (let attempt = 0; attempt < 200 && !done(value); attempt++) {
      yield* Effect.sleep(Duration.millis(25));
      value = yield* check;
    }
    return value;
  });

export const mailStream: StreamDescriptor = {
  id: "me@example.com",
  kind: "message",
  name: "me@example.com",
  me: ["me@example.com"],
  openLabel: "Open",
};

export const rawItem = (externalId: string, overrides: Partial<RawItem>): RawItem => ({
  externalId,
  threadId: null,
  containerId: "INBOX",
  containerName: "Inbox",
  occurredAt: "2026-10-20T09:00:00Z",
  title: null,
  from: { name: "Ada", address: "ada@example.com" },
  body: "",
  bodyNew: "",
  link: null,
  raw: {},
  ...overrides,
});

export interface FakeSource {
  streams: () => Promise<ReadonlyArray<StreamDescriptor>>;
  items: ReadonlyArray<RawItem>;
  pending: Array<RawItem>;
  syncCalls: number;
}

export const fakeSource = (items: ReadonlyArray<RawItem>): FakeSource => ({
  streams: async () => [mailStream],
  items,
  pending: [],
  syncCalls: 0,
});

export const fakePlugin = (state: FakeSource): SourcePlugin<unknown> => ({
  id: "fake",
  configSchema: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.String)),
  create: (): Source => ({
    streams: () => state.streams(),
    sync: async (_streamId, cursor) => {
      state.syncCalls += 1;
      return {
        upserts: cursor === null ? state.items : state.pending.splice(0),
        deletions: [],
        cursor: "done",
        more: false,
      };
    },
  }),
});

export const filePlugin = (file: string): SourcePlugin<unknown> => ({
  id: "file",
  configSchema: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.String)),
  create: (): Source => ({
    streams: async () => [mailStream],
    sync: async (_streamId, cursor) => {
      const items = JSON.parse(readFileSync(file, "utf8")) as Array<RawItem>;
      return {
        upserts: items.slice(cursor === null ? 0 : Number(cursor)),
        deletions: [],
        cursor: String(items.length),
        more: false,
      };
    },
  }),
});

export const sourceConfig = (syncEvery = "50ms") => `[[source]]
id = "mail"
plugin = "fake"
sync_every = "${syncEvery}"

[source.config]
mode = "test"
`;

export interface Capture {
  readonly input: DigestInput;
  readonly attempt: number;
  readonly hasError: boolean;
}

export const fakeAi = [join(import.meta.dirname, "../node_modules/.bin/fake-ai")];

export interface DigestOptions {
  readonly capture: string;
  readonly wrap?: ReadonlyArray<string>;
  readonly args?: ReadonlyArray<string>;
  readonly concurrency?: number;
  readonly guide?: string;
}

export const digestConfig = ({
  capture,
  wrap = [],
  args = [],
  concurrency = 1,
  guide,
}: DigestOptions) => `
[ai.fake]
command = ${JSON.stringify([...wrap, ...fakeAi, "--capture", capture, ...args])}
timeout = "20s"
concurrency = ${concurrency}

[digest]
ai = "fake"
threshold = 1000
max_input = 24000
context = 6000
${guide === undefined ? "" : `guide = ${JSON.stringify(guide)}`}
`;

export const readCapture = (path: string): Array<Capture> =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Capture)
    : [];

export const processesMentioning = (marker: string) =>
  new TextDecoder()
    .decode(Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout)
    .split("\n")
    .filter((line) => line.includes(marker) && !line.includes("ps -axo"))
    .map((line) => Number.parseInt(line.trim(), 10));
