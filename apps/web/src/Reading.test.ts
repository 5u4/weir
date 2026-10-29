import * as Effect from "effect/Effect";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, expect, it, vi } from "vitest";
import { reading } from "./Reading.ts";
import { ConversationId } from "./Route.ts";
import { conversation } from "./Weir.ts";

const daemon = vi.hoisted(() => {
  const last = 25;
  const state = { seen: 9 };
  const requests: Array<string> = [];
  const held: Array<() => void> = [];
  const party = { name: "Ada Lovelace", address: "ada@example.com", me: false };
  const row = () => ({
    id: 1,
    source: "gmail",
    title: "#1",
    tags: [],
    first_at: "2026-10-25T09:00:00.000Z",
    last_at: "2026-10-25T09:00:00.000Z",
    last_seq: last,
    seen_seq: state.seen,
    cleared_seq: 0,
    muted: false,
    state: state.seen >= last ? "read" : "unread",
    new: last - state.seen,
    items: 1,
    participants: 1,
    from: party,
    preview: "Ada: hello",
    senders: [party],
  });
  const body = async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? await input.text() : init?.body;
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
    return JSON.parse(text === "" ? "{}" : text) as { readonly seq?: number };
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "POST" && url.pathname === "/conversations/1/read") {
      const { seq = 0 } = await body(input, init);
      requests.push(`read ${seq}`);
      const hold = Promise.withResolvers<void>();
      held.push(hold.resolve);
      await hold.promise;
      state.seen = Math.max(state.seen, Math.min(seq, last));
      requests.push(`read ${seq} applied`);
      return Response.json(row());
    }
    if (method === "POST" && url.pathname === "/conversations/1/unread") {
      const { seq } = await body(input, init);
      requests.push(`unread ${seq ?? "last"}`);
      state.seen = Math.max(0, Math.min(seq ?? last, last) - 1);
      return Response.json(row());
    }
    if (method === "GET" && url.pathname === "/conversations/1") {
      return Response.json({
        id: 1,
        source: "gmail",
        title: "#1",
        first_at: "2026-10-25T09:00:00.000Z",
        last_at: "2026-10-25T09:00:00.000Z",
        tags: [],
        open: null,
        state: { seen_seq: state.seen, cleared_seq: 0, muted: false, state: row().state },
        items: [
          {
            seq: last,
            conversation_id: 1,
            container_name: "INBOX",
            occurred_at: "2026-10-25T09:00:00.000Z",
            title: null,
            from: party,
            from_me: false,
            link: null,
            body: "hello",
            body_new: "hello",
            raw: null,
            deleted_at: null,
          },
        ],
        digests: [],
        digest: { backlog: null, earlier: null, now: null, last_failure: null },
      });
    }
    return new Response(null, { status: 404 });
  };
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("location", { origin: "http://weir.test", search: "" });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  return { last, state, requests, held };
});

afterEach(() => {
  daemon.state.seen = 9;
  daemon.requests.length = 0;
  daemon.held.length = 0;
});

const id = ConversationId.make(1);

const opened = async () => {
  const registry = AtomRegistry.make();
  registry.mount(conversation(id));
  await Effect.runPromise(
    AtomRegistry.getResult(registry, conversation(id), { suspendOnWaiting: true }),
  );
  const close = registry.mount(reading(id));
  const reader = registry.get(reading(id));
  reader.dispatch({ _tag: "Input" });
  reader.dispatch({ _tag: "Viewport", inView: daemon.last });
  await vi.waitFor(() => expect(daemon.requests).toEqual([`read ${daemon.last}`]));
  return { registry, close, reader };
};

it("Mark unread waits for a read still in flight, so the conversation stays unread", async () => {
  const { registry, reader } = await opened();

  reader.unread(null);

  for (const release of daemon.held) release();
  await vi.waitFor(() =>
    expect(daemon.requests).toEqual([
      `read ${daemon.last}`,
      `read ${daemon.last} applied`,
      "unread last",
    ]),
  );
  expect(daemon.state.seen).toBe(daemon.last - 1);
  registry.dispose();
});

it("Mark unread followed by closing the conversation still lands after the read", async () => {
  const { registry, close, reader } = await opened();

  reader.unread(12);
  close();
  for (const release of daemon.held) release();
  await vi.waitFor(() =>
    expect(daemon.requests).toEqual([
      `read ${daemon.last}`,
      `read ${daemon.last} applied`,
      "unread 12",
    ]),
  );
  expect(daemon.state.seen).toBe(11);
  registry.dispose();
});
