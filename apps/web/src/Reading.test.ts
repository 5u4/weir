import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, expect, it, vi } from "vitest";
import { dock, reading } from "./Reading.ts";
import { ConversationId } from "./Route.ts";
import { conversation, dismiss } from "./Weir.ts";

const daemon = vi.hoisted(() => {
  const state = { seen: 9, last: 25, cleared: 25, muted: false };
  const requests: Array<string> = [];
  const held: Array<() => void> = [];
  const failing = new Set<string>();
  const party = { name: "Ada Lovelace", address: "ada@example.com", me: false };
  const standing = () =>
    state.muted
      ? "muted"
      : state.cleared >= state.last
        ? "done"
        : state.seen >= state.last
          ? "read"
          : "unread";
  const row = () => ({
    id: 1,
    source: "gmail",
    title: "#1",
    tags: [],
    first_at: "2026-10-25T09:00:00.000Z",
    last_at: "2026-10-25T09:00:00.000Z",
    last_seq: state.last,
    seen_seq: state.seen,
    cleared_seq: state.cleared,
    muted: state.muted,
    state: standing(),
    new: state.last - state.seen,
    items: 1,
    participants: 1,
    from: party,
    preview: "Ada: hello",
    senders: [party],
  });
  const body = (init?: RequestInit) => {
    const raw = init?.body;
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array);
    return JSON.parse(text === "" ? "{}" : text) as { readonly seq?: number };
  };
  const writes: Readonly<Record<string, (seq: number | undefined) => void>> = {
    read: (seq = 0) => {
      state.seen = Math.max(state.seen, Math.min(seq, state.last));
    },
    unread: (seq) => {
      state.seen = Math.max(0, Math.min(seq ?? state.last, state.last) - 1);
    },
    mute: () => {
      state.muted = true;
    },
    restore: () => {
      state.muted = false;
      state.cleared = 0;
      state.seen = Math.max(state.seen, state.last);
    },
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const write = url.pathname.match(/^\/conversations\/1\/(\w+)$/)?.[1];
    if (method === "POST" && write !== undefined && Object.hasOwn(writes, write)) {
      const { seq } = body(init);
      const label = seq === undefined ? write : `${write} ${seq}`;
      requests.push(label);
      const hold = Promise.withResolvers<void>();
      held.push(hold.resolve);
      await hold.promise;
      if (failing.has(label)) {
        requests.push(`${label} failed`);
        return new Response(null, { status: 500 });
      }
      writes[write]?.(seq);
      requests.push(`${label} applied`);
      return Response.json(row());
    }
    if (method === "GET" && url.pathname === "/conversations") {
      return Response.json({ seq: state.last, conversations: [row()] });
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
        state: {
          seen_seq: state.seen,
          cleared_seq: state.cleared,
          muted: state.muted,
          state: standing(),
        },
        items: [
          {
            seq: state.last,
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
  return { state, requests, held, failing };
});

afterEach(() => {
  Object.assign(daemon.state, { seen: 9, last: 25, cleared: 25, muted: false });
  daemon.requests.length = 0;
  daemon.held.length = 0;
  daemon.failing.clear();
});

const id = ConversationId.make(1);
const target = { id: 1, last_seq: 25, cleared_seq: 25 };

const loaded = async () => {
  const registry = AtomRegistry.make();
  registry.mount(conversation(id));
  await Effect.runPromise(
    AtomRegistry.getResult(registry, conversation(id), { suspendOnWaiting: true }),
  );
  return registry;
};

const opened = async () => {
  const registry = await loaded();
  const close = registry.mount(reading(id));
  const reader = registry.get(reading(id));
  reader.dispatch({ _tag: "Input" });
  reader.dispatch({ _tag: "Viewport", inView: 25 });
  await vi.waitFor(() => expect(daemon.requests).toEqual(["read 25"]));
  return { registry, close, reader };
};

const releaseNewestFirst = (applied: ReadonlyArray<string>) =>
  vi.waitFor(() => {
    for (const release of daemon.held.splice(0).reverse()) release();
    expect(daemon.requests.filter((request) => request.endsWith(" applied"))).toEqual(
      applied.map((request) => `${request} applied`),
    );
  });

it("Mark unread waits for a read still in flight, so the conversation stays unread", async () => {
  const { registry, reader } = await opened();

  reader.unread(null);

  await releaseNewestFirst(["read 25", "unread 25"]);
  expect(daemon.state.seen).toBe(24);
  registry.dispose();
});

it("Mark unread keeps mail that arrives before it lands unread", async () => {
  const { registry, reader } = await opened();

  reader.unread(null);
  daemon.state.last = 30;

  await releaseNewestFirst(["read 25", "unread 25"]);
  expect(daemon.state.seen).toBe(24);
  registry.dispose();
});

it("Mark unread followed by closing the conversation still lands after the read", async () => {
  const { registry, close, reader } = await opened();

  reader.unread(12);
  close();

  await releaseNewestFirst(["read 25", "unread 12"]);
  expect(daemon.state.seen).toBe(11);
  registry.dispose();
});

it("a second Mark unread lands after the first, so the later choice wins", async () => {
  const registry = await loaded();
  registry.mount(reading(id));
  const reader = registry.get(reading(id));

  reader.unread(null);
  reader.unread(12);

  await releaseNewestFirst(["unread 25", "unread 12"]);
  expect(daemon.state.seen).toBe(11);
  registry.dispose();
});

it("Mark unread after reopening still lands after a read from the earlier visit", async () => {
  const { registry, close, reader } = await opened();

  close();
  await vi.waitFor(() => expect(registry.getNodes().has(reading(id))).toBe(false));
  registry.mount(reading(id));
  const reopened = registry.get(reading(id));
  expect(reopened).not.toBe(reader);
  reopened.unread(12);

  await releaseNewestFirst(["read 25", "unread 12"]);
  expect(daemon.state.seen).toBe(11);
  registry.dispose();
});

it.each([
  ["the first Mark unread fails and the second lands", "unread 25", "unread 12 applied"],
  ["the first Mark unread lands and the second fails", "unread 12", "unread 25 applied"],
])("%s, so reading stays paused until the conversation closes", async (_, fails, landed) => {
  const registry = await loaded();
  registry.mount(reading(id));
  const reader = registry.get(reading(id));
  daemon.failing.add(fails);

  reader.unread(null);
  reader.unread(12);
  await vi.waitFor(() => {
    for (const release of daemon.held.splice(0)) release();
    expect(daemon.requests).toContain(`${fails} failed`);
    expect(daemon.requests).toContain(landed);
  });
  reader.dispatch({ _tag: "Input" });
  reader.dispatch({ _tag: "Viewport", inView: 25 });
  reader.dispatch({ _tag: "Leave" });
  registry.set(dismiss, { act: "Mute", target });

  await vi.waitFor(() => {
    for (const release of daemon.held.splice(0)) release();
    expect(daemon.requests).toContain("mute applied");
  });
  expect(daemon.requests.filter((request) => request.startsWith("read"))).toEqual([]);
  registry.dispose();
});

it("Restore clicked after Mute lands last, so the conversation ends unmuted", async () => {
  const registry = await loaded();

  registry.set(dismiss, { act: "Mute", target });
  registry.set(dismiss, { act: "Restore", target });

  await releaseNewestFirst(["mute", "restore"]);
  expect(daemon.state.muted).toBe(false);
  registry.dispose();
});

it("Restore reads the open conversation, so Mark unread is offered and Last read stays put", async () => {
  const registry = await loaded();
  registry.mount(reading(id));
  registry.mount(dock(id));

  registry.set(dismiss, { act: "Restore", target });

  await releaseNewestFirst(["restore"]);
  await vi.waitFor(() => expect(registry.get(reading(id)).seen).toBe(25));
  expect(registry.get(reading(id)).frozen).toEqual(Option.some(9));
  expect(Option.map(registry.get(dock(id)), ({ actions }) => actions)).toEqual(
    Option.some(["Done", "MarkUnread", "Mute"]),
  );
  registry.dispose();
});
