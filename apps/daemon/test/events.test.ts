import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { RawItem } from "@weir/contract/Source";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { Event } from "../src/Api.ts";
import * as Events from "../src/Events.ts";
import type { WeirHome } from "../src/Home.ts";
import * as Http from "../src/Http.ts";
import {
  apiClient,
  type DigestOptions,
  digestConfig,
  eventually,
  type FakeSource,
  fakePlugin,
  fakeSource,
  makeHome,
  rawItem,
  sourceConfig,
} from "./harness.ts";

type Frame = { readonly kind: "ping" } | { readonly kind: "event"; readonly event: Event };

const openEvents = (port: number) =>
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

type SyncEvent = Extract<Event, { type: "sync" }>;

const isSync =
  (status?: SyncEvent["status"]) =>
  (event: Event): event is SyncEvent =>
    event.type === "sync" && (status === undefined || event.status === status);

const isDigest = (event: Event): event is Extract<Event, { type: "digest" }> =>
  event.type === "digest";

const workTag = `
[[tag]]
name = "Work"
match = { type = "regex", target = "/title", regex = "work", flags = "i" }
`;

const pingInterval = Layer.succeed(Events.PingInterval, Duration.millis(50));

const serve = (home: WeirHome, source: FakeSource) =>
  Layer.build(Http.layer(home, { fake: fakePlugin(source) }).pipe(Layer.provide(pingInterval)));

interface StartOptions {
  readonly syncEvery?: string;
  readonly digest?: Omit<DigestOptions, "capture">;
}

const start = ({ syncEvery = "50ms", digest }: StartOptions = {}) =>
  Effect.gen(function* () {
    const { home, port, writeConfig } = makeHome("");
    const capture = join(home.root, "capture.jsonl");
    writeConfig(
      sourceConfig(syncEvery) +
        (digest === undefined ? "" : digestConfig({ capture, ...digest })) +
        workTag,
    );
    const source = fakeSource([]);
    const daemonScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(daemonScope, Exit.void));
    yield* serve(home, source).pipe(Scope.provide(daemonScope));
    const client = yield* apiClient(port);
    yield* eventually(client.status(), ({ sources }) =>
      sources.every(
        ({ streams }) => streams.length > 0 && streams.every(({ backfill }) => backfill === "done"),
      ),
    );
    const maxSeq = client
      .conversations({ query: { view: { _tag: "Untagged" } } })
      .pipe(Effect.map(({ seq }) => seq));
    const deliver = (items: ReadonlyArray<RawItem>) =>
      Effect.gen(function* () {
        const before = yield* maxSeq;
        source.pending.push(...items);
        yield* eventually(maxSeq, (seq) => seq >= before + items.length);
      });
    const conversationOf = (title: string) =>
      client.search({ query: { q: "" } }).pipe(
        Effect.map(({ conversations }) => {
          const found = conversations.find((conversation) => conversation.title === title);
          if (found === undefined) throw new Error(`no conversation titled ${title}`);
          return found;
        }),
      );
    return {
      home,
      port,
      client,
      source,
      deliver,
      conversationOf,
      shutdown: Scope.close(daemonScope, Exit.void),
      writeConfig,
    };
  });

const item = (externalId: string, title: string, minute: number) =>
  rawItem(externalId, {
    threadId: title,
    title,
    occurredAt: `2026-10-28T09:${String(minute).padStart(2, "0")}:00Z`,
    body: "word ".repeat(20),
    bodyNew: "word ".repeat(20),
  });

describe("events", () => {
  it.live("e1: the first event is ready and an idle stream gets pings", () =>
    Effect.gen(function* () {
      const { port } = yield* start({ syncEvery: "1h" });
      const events = yield* openEvents(port);
      expect(yield* events.take).toEqual({ kind: "event", event: { type: "ready" } });
      expect(yield* events.take).toEqual({ kind: "ping" });
      expect(yield* events.take).toEqual({ kind: "ping" });
    }).pipe(Effect.scoped),
  );

  it.live("e2: sync reports started then done, failed with its error, and written ids", () =>
    Effect.gen(function* () {
      const { port, source, conversationOf } = yield* start();
      const events = yield* openEvents(port);
      const started = yield* events.until(isSync("started"));
      expect(started).toMatchObject({ type: "sync", source: "mail", status: "started" });
      const after = yield* events.until(isSync());
      expect(after).toMatchObject({ type: "sync", source: "mail", status: "done" });
      expect(after).not.toHaveProperty("error");
      expect(Number.isNaN(Date.parse(after.at))).toBe(false);

      source.pending.push(item("n1", "Fresh news", 1));
      const written = yield* events.state;
      const fresh = yield* conversationOf("Fresh news");
      expect(written).toEqual({ type: "state", ids: [fresh.id] });

      source.streams = async () => {
        throw new Error("gws is down");
      };
      const failed = yield* events.until(isSync("failed"));
      expect(failed).toMatchObject({ type: "sync", source: "mail", status: "failed" });
      expect(failed.error).toContain("gws is down");
    }).pipe(Effect.scoped),
  );

  it.live("e3: a manual digest reports queued, running, done; a failing AI reports its log", () =>
    Effect.gen(function* () {
      const { port, client, deliver, conversationOf, home, writeConfig } = yield* start({
        digest: {},
      });
      yield* deliver([1, 2, 3].map((n) => item(`l${n}`, "List news", n)));
      const { id } = yield* conversationOf("List news");
      const { items } = yield* client.conversation({ params: { id } });
      const first = items[0]?.seq;
      const last = items[2]?.seq;
      if (first === undefined || last === undefined) throw new Error("3 items");

      const events = yield* openEvents(port);
      yield* events.take;
      yield* client.digest({ params: { id }, payload: {} });
      const range = { conversation_id: id, from_seq: first, to_seq: last, trigger: "manual" };
      expect(yield* events.until(isDigest)).toEqual({ type: "digest", ...range, status: "queued" });
      expect(yield* events.until(isDigest)).toEqual({
        type: "digest",
        ...range,
        status: "running",
      });
      expect(yield* events.until(isDigest)).toEqual({ type: "digest", ...range, status: "done" });

      const capture = join(home.root, "capture.jsonl");
      writeConfig(
        sourceConfig() + digestConfig({ capture, args: ["--invalid", "always"] }) + workTag,
      );
      yield* client.reload();
      yield* deliver([item("l4", "List news", 4)]);
      const fourth = (yield* client.conversation({ params: { id } })).items[3]?.seq;
      if (fourth === undefined) throw new Error("4 items");
      yield* Effect.flip(client.digest({ params: { id }, payload: {} }));
      const next = { conversation_id: id, from_seq: fourth, to_seq: fourth, trigger: "manual" };
      expect(yield* events.until(isDigest)).toEqual({ type: "digest", ...next, status: "queued" });
      expect(yield* events.until(isDigest)).toEqual({ type: "digest", ...next, status: "running" });
      const failed = yield* events.until(isDigest);
      expect(failed).toMatchObject({ type: "digest", ...next, status: "failed" });
      expect(failed.error).toBeTruthy();
      expect(existsSync(failed.log_path ?? "")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("e4: read, done and clear emit exactly the changed ids; a no-op emits nothing", () =>
    Effect.gen(function* () {
      const { port, client, deliver, conversationOf } = yield* start();
      yield* deliver([
        item("a1", "Work alpha", 1),
        item("b1", "Work beta", 2),
        item("c1", "Lunch", 3),
      ]);
      const alpha = yield* conversationOf("Work alpha");
      const beta = yield* conversationOf("Work beta");
      const lunch = yield* conversationOf("Lunch");
      const work = { _tag: "Tag", name: "Work" } as const;
      const events = yield* openEvents(port);
      yield* events.take;

      yield* client.read({ params: { id: alpha.id }, payload: { seq: alpha.last_seq } });
      expect(yield* events.state).toEqual({ type: "state", ids: [alpha.id] });
      yield* client.read({ params: { id: alpha.id }, payload: { seq: alpha.last_seq } });
      yield* client.done({ params: { id: alpha.id }, payload: { seq: alpha.last_seq } });
      expect(yield* events.state).toEqual({ type: "state", ids: [alpha.id] });

      const { seq } = yield* client.conversations({ query: { view: work } });
      expect(yield* client.clear({ payload: { view: work, seq } })).toEqual({ cleared: 1 });
      expect(yield* events.state).toEqual({ type: "state", ids: [beta.id] });

      expect(yield* client.clear({ payload: { view: work, seq } })).toEqual({ cleared: 0 });
      yield* client.read({ params: { id: lunch.id }, payload: { seq: lunch.last_seq } });
      expect(yield* events.state).toEqual({ type: "state", ids: [lunch.id] });
    }).pipe(Effect.scoped),
  );

  it.live("e5: a reconnect gets ready first and daemon shutdown ends the stream", () =>
    Effect.gen(function* () {
      const { port, shutdown } = yield* start();
      const first = yield* openEvents(port);
      expect(yield* first.take).toEqual({ kind: "event", event: { type: "ready" } });
      yield* first.close;
      const second = yield* openEvents(port);
      expect(yield* second.take).toEqual({ kind: "event", event: { type: "ready" } });
      const [elapsed] = yield* Effect.timed(shutdown);
      expect(Duration.toMillis(elapsed)).toBeLessThan(2_000);
      for (;;) {
        const frame = yield* second.take;
        if (frame === "end") break;
      }
    }).pipe(Effect.scoped),
  );

  it.live("e6: the stream survives a reload and carries a later state change", () =>
    Effect.gen(function* () {
      const { port, client, deliver, conversationOf } = yield* start();
      yield* deliver([item("r1", "Work reload", 1)]);
      const { id, last_seq } = yield* conversationOf("Work reload");
      const events = yield* openEvents(port);
      yield* events.take;
      yield* client.reload();
      yield* client.read({ params: { id }, payload: { seq: last_seq } });
      expect(yield* events.state).toEqual({ type: "state", ids: [id] });
    }).pipe(Effect.scoped),
  );

  it.live("e7: a daemon process with an open stream shuts down in under 2 s", () =>
    Effect.gen(function* () {
      const { home, port } = makeHome(sourceConfig("1h"));
      writeFileSync(join(home.root, "source.json"), "[]");
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
      const events = yield* openEvents(port);
      expect(yield* events.take).toEqual({ kind: "event", event: { type: "ready" } });
      const [elapsed] = yield* Effect.timed(
        Effect.promise(() => {
          child.kill("SIGTERM");
          return child.exited;
        }),
      );
      expect(Duration.toMillis(elapsed)).toBeLessThan(2_000);
    }).pipe(Effect.scoped),
  );

  it.live("e8: a read sent the moment ready arrives shows up on that stream", () =>
    Effect.gen(function* () {
      const { port, client, deliver, conversationOf } = yield* start();
      yield* deliver([item("q1", "Work quick", 1)]);
      const { id, last_seq } = yield* conversationOf("Work quick");
      for (let round = 0; round < 5; round++) {
        yield* client.unread({ params: { id }, payload: {} });
        const events = yield* openEvents(port);
        expect(yield* events.take).toEqual({ kind: "event", event: { type: "ready" } });
        yield* client.read({ params: { id }, payload: { seq: last_seq } });
        expect(yield* events.state).toEqual({ type: "state", ids: [id] });
        yield* events.close;
      }
    }).pipe(Effect.scoped),
  );
});
