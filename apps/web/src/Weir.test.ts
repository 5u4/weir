import type { Event, Row } from "@weir/daemon/Api";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationId } from "./Route.ts";
import { shown } from "./Rows.ts";
import { conversation, counts, dismiss, intents, live, viewList } from "./Weir.ts";

const daemon = vi.hoisted(() => {
  const rows = new Map<number, Row>();
  const requests: Array<string> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push(`${method} ${url.pathname}`);
    const done = rows.get(Number(url.pathname.match(/^\/conversations\/(\d+)\/done$/)?.[1]));
    if (method === "POST" && done !== undefined) {
      const next: Row = { ...done, cleared_seq: done.last_seq, state: "done" };
      rows.set(next.id, next);
      return Response.json(next);
    }
    if (method === "GET" && url.pathname === "/conversations") {
      const cleared = url.searchParams.get("view") === "cleared";
      return Response.json({
        seq: 10,
        conversations: [...rows.values()].filter(
          (row) => row.cleared_seq >= row.last_seq === cleared,
        ),
      });
    }
    if (method === "GET" && url.pathname === "/counts") {
      return Response.json({
        unread: 0,
        tags: [],
        untagged: { unread: 0, open: rows.size, senders: [] },
        cleared: 0,
      });
    }
    const open = Number(url.pathname.match(/^\/conversations\/(\d+)$/)?.[1]);
    if (method === "GET" && Number.isInteger(open)) {
      return Response.json({
        id: open,
        source: "gmail",
        title: `#${open}`,
        first_at: "2026-10-25T09:00:00.000Z",
        last_at: "2026-10-25T09:00:00.000Z",
        tags: [],
        state: { seen_seq: 0, cleared_seq: 0, muted: false, state: "read" },
        items: [],
        digests: [],
        digest: { backlog: null, earlier: null, now: null, last_failure: null },
      });
    }
    return new Response(null, { status: 404 });
  };
  class Source {
    static opened: Array<Source> = [];
    readonly listeners = new Map<string, (event: { readonly data?: string }) => void>();
    closed = false;
    readonly url: URL;
    constructor(url: URL) {
      this.url = url;
      Source.opened.push(this);
    }
    addEventListener(type: string, listener: (event: { readonly data?: string }) => void) {
      this.listeners.set(type, listener);
    }
    close() {
      this.closed = true;
    }
    send(event: unknown) {
      this.listeners.get("message")?.({ data: JSON.stringify(event) });
    }
    drop() {
      this.listeners.get("error")?.({});
    }
  }
  const location = { origin: "http://weir.test", search: "" };
  vi.stubGlobal("location", location);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("EventSource", Source);
  return { rows, requests, Source, location };
});

const row = (id: number, last_seq: number): Row => ({
  id,
  source: "gmail",
  title: `#${id}`,
  tags: [],
  first_at: "2026-10-25T09:00:00.000Z",
  last_at: "2026-10-25T09:00:00.000Z",
  last_seq,
  seen_seq: last_seq,
  cleared_seq: 0,
  muted: false,
  state: "read",
  new: 0,
  items: 1,
  participants: 1,
  from: { name: "Ada Lovelace", address: "ada@example.com", me: false },
  preview: "Ada: hello",
  senders: [{ name: "Ada Lovelace", address: "ada@example.com", me: false }],
});

const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));

afterEach(() => {
  daemon.rows.clear();
  daemon.requests.length = 0;
  daemon.Source.opened.length = 0;
  daemon.location.search = "";
});

const refetched = async (event: Event, expected: ReadonlyArray<string>) => {
  daemon.requests.length = 0;
  daemon.Source.opened.at(-1)?.send(event);
  await vi.waitFor(() => expect(daemon.requests.toSorted()).toEqual(expected));
};

it("each event refetches only what it changes, and a dropped stream reconnects", async () => {
  daemon.rows.set(1, row(1, 5));
  daemon.location.search = "?c=5";
  const registry = AtomRegistry.make();
  const list = viewList("untagged");
  const open = conversation(ConversationId.make(5));
  registry.mount(list);
  registry.mount(counts);
  registry.mount(open);
  registry.mount(live);
  await Promise.all([settled(registry, list), settled(registry, counts), settled(registry, open)]);
  expect(daemon.Source.opened.map(({ url }) => url.href)).toEqual(["http://weir.test/events"]);

  await refetched({ type: "ready" }, ["GET /conversations", "GET /conversations/5", "GET /counts"]);
  await refetched({ type: "state", ids: [9] }, ["GET /conversations", "GET /counts"]);
  await refetched({ type: "state", ids: [5] }, [
    "GET /conversations",
    "GET /conversations/5",
    "GET /counts",
  ]);

  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const first = daemon.Source.opened[0];
  first?.drop();
  expect(first?.closed).toBe(true);
  expect(daemon.Source.opened).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(500);
  vi.useRealTimers();
  expect(daemon.Source.opened).toHaveLength(2);
  await refetched({ type: "ready" }, ["GET /conversations", "GET /conversations/5", "GET /counts"]);

  registry.dispose();
  expect(daemon.Source.opened.at(-1)?.closed).toBe(true);
});

it("Done hides the row until the server agrees, then defers to whatever the server says next", async () => {
  daemon.rows.set(1, row(1, 5));
  daemon.rows.set(2, row(2, 6));
  const registry = AtomRegistry.make();
  const list = viewList("untagged");
  registry.mount(list);
  await settled(registry, list);

  const visible = () =>
    AsyncResult.getOrElse(
      AsyncResult.map(registry.get(list), ({ conversations }) =>
        shown("untagged", conversations, registry.get(intents)).map(({ id }) => id),
      ),
      () => [],
    );
  const seen: Array<ReadonlyArray<number>> = [];
  const record = () => seen.push(visible());
  const stop = [registry.subscribe(list, record), registry.subscribe(intents, record)];

  const target = daemon.rows.get(1);
  if (target === undefined) throw new Error("fixture row 1 missing");
  registry.set(dismiss, { view: "untagged", row: target });
  await settled(registry, dismiss);

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((ids) => ids.includes(1))).toEqual([]);
  expect(registry.get(intents).size).toBe(0);

  daemon.rows.set(1, row(1, 5));
  registry.refresh(list);
  await settled(registry, list);
  expect(visible()).toEqual([1, 2]);

  for (const release of stop) release();
  registry.dispose();
});
