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
import { Api, type Event } from "../src/Api.ts";
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

export const eventually = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  attempts = 200,
) =>
  Effect.gen(function* () {
    let value = yield* check;
    for (let attempt = 0; attempt < attempts && !done(value); attempt++) {
      yield* Effect.sleep(Duration.millis(25));
      value = yield* check;
    }
    return value;
  });

export const spawnDaemon = (home: Home.WeirHome) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(["bun", join(import.meta.dirname, "daemon-process.ts")], {
          env: { ...Bun.env, WEIR_HOME: home.root },
          stdout: "ignore",
          stderr: "inherit",
        }),
      ),
      (running) =>
        Effect.promise(async () => {
          running.kill("SIGKILL");
          await running.exited;
        }),
    );
    yield* eventually(
      Effect.sync(() =>
        existsSync(home.daemon) ? JSON.parse(readFileSync(home.daemon, "utf8")).pid : null,
      ),
      (pid) => pid === child.pid,
    );
    return child;
  });

type Frame = { readonly kind: "ping" } | { readonly kind: "event"; readonly event: Event };

export const openEvents = (port: number) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/events`, {
        signal: controller.signal,
      });
      const body = response.body;
      if (body === null) throw new Error("no /events body");
      const reader = body.getReader();
      const decoder = new TextDecoder();
      const frames: Array<Frame> = [];
      const wakers = new Set<() => void>();
      let ended = false;
      let text = "";
      let cursor = 0;
      const wake = () => {
        for (const waker of wakers) waker();
      };
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            let end = text.indexOf("\n\n");
            while (end !== -1) {
              const block = text.slice(0, end);
              text = text.slice(end + 2);
              end = text.indexOf("\n\n");
              if (block.startsWith(":")) {
                frames.push({ kind: "ping" });
                continue;
              }
              const data = block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              frames.push({ kind: "event", event: JSON.parse(data) as Event });
            }
            wake();
          }
        } catch {}
        ended = true;
        wake();
      })();
      const next = () =>
        new Promise<Frame | "end">((resolve) => {
          const check = () => {
            const frame = frames[cursor];
            if (frame !== undefined) {
              cursor += 1;
              wakers.delete(check);
              resolve(frame);
            } else if (ended) {
              wakers.delete(check);
              resolve("end");
            }
          };
          wakers.add(check);
          check();
        });
      return { next, controller };
    }),
    ({ controller }) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.map(({ next, controller }) => {
      const take = Effect.promise(next);
      const until = <A extends Event>(match: (event: Event) => event is A) =>
        Effect.gen(function* () {
          for (;;) {
            const frame = yield* take;
            if (frame === "end") throw new Error("/events ended");
            if (frame.kind === "event" && match(frame.event)) return frame.event;
          }
        });
      return {
        take,
        until,
        state: until((event): event is Extract<Event, { type: "state" }> => event.type === "state"),
        close: Effect.sync(() => controller.abort()),
      };
    }),
  );

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
  pendingDeletions: Array<string>;
  syncCalls: number;
  failingStreams: Set<string>;
}

export const fakeSource = (items: ReadonlyArray<RawItem>): FakeSource => ({
  streams: async () => [mailStream],
  items,
  pending: [],
  pendingDeletions: [],
  syncCalls: 0,
  failingStreams: new Set(),
});

export const fakePlugin = (state: FakeSource): SourcePlugin<unknown> => ({
  id: "fake",
  configSchema: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.String)),
  create: (): Source => ({
    streams: () => state.streams(),
    sync: async (streamId, cursor) => {
      state.syncCalls += 1;
      if (state.failingStreams.has(streamId)) throw new Error(`${streamId} is unreachable`);
      return {
        upserts: cursor === null ? state.items : state.pending.splice(0),
        deletions: cursor === null ? [] : state.pendingDeletions.splice(0),
        cursor: "done",
        more: false,
        kind: cursor === null ? "backfill" : "live",
        backfill: "done",
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
        kind: cursor === null ? "backfill" : "live",
        backfill: "done",
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
  readonly maxInput?: number;
  readonly guide?: string;
}

export const digestConfig = ({
  capture,
  wrap = [],
  args = [],
  concurrency = 1,
  maxInput = 24000,
  guide,
}: DigestOptions) => `
[ai.fake]
command = ${JSON.stringify([...wrap, ...fakeAi, "--capture", capture, ...args])}
timeout = "20s"
concurrency = ${concurrency}

[digest]
ai = "fake"
threshold = 1000
max_input = ${maxInput}
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
