import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationId, route } from "./Route.ts";
import {
  counts,
  dismiss,
  found,
  listMotion,
  searchGroup,
  searchResult,
  viewList,
  visibleRows,
} from "./Weir.ts";

const daemon = vi.hoisted(() => {
  const origin = "http://weir.test";
  const page = { search: "", rows: [] as Array<object> };
  const frames: Array<() => void> = [];
  const searches: Array<URLSearchParams> = [];
  const held: Array<{ q: string; reply: (ids: ReadonlyArray<number>) => void }> = [];
  const mode = { hold: false };
  const results: Array<number> = [1];
  const listed: Array<number> = [];
  const tagged = new Map<number, ReadonlyArray<string>>();
  const row = (id: number) => ({
    id,
    source: "personal-mail",
    title: `#${id}`,
    tags: tagged.get(id) ?? [],
    first_at: "2026-10-25T09:00:00.000Z",
    last_at: "2026-10-25T09:00:00.000Z",
    last_seq: 1,
    seen_seq: 1,
    cleared_seq: 0,
    muted: false,
    state: "read",
    new: 0,
    items: 1,
    participants: 1,
    from: { name: "Ada Lovelace", address: "ada@example.com", me: false },
    preview: "Ada: hello",
    senders: [],
    hits: [],
  });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const done = Number(url.pathname.match(/^\/conversations\/(\d+)\/done$/)?.[1]);
    if (method === "POST" && Number.isInteger(done)) {
      return Response.json({ ...row(done), cleared_seq: 1, state: "done" });
    }
    if (url.pathname === "/conversations") {
      return Response.json({ seq: 1, conversations: listed.map(row) });
    }
    if (url.pathname === "/counts") {
      return Response.json({
        unread: 0,
        tags: [{ name: "Me", unread: 0, open: 0, senders: [] }],
        untagged: { unread: 0, open: 0, senders: [] },
        cleared: 0,
      });
    }
    if (url.pathname === "/search") {
      searches.push(url.searchParams);
      const q = url.searchParams.get("q") ?? "";
      const respond = (ids: ReadonlyArray<number>) =>
        Response.json({ conversations: ids.map(row) });
      if (!mode.hold) return respond(results);
      return new Promise<Response>((resolve) => {
        held.push({ q, reply: (ids) => resolve(respond(ids)) });
      });
    }
    return new Response(null, { status: 404 });
  };
  const moveTo = (_: unknown, __: string, url: string) => {
    page.search = new URL(url, origin).search;
  };
  vi.stubGlobal("document", { hidden: false, querySelectorAll: () => page.rows });
  vi.stubGlobal("requestAnimationFrame", (frame: () => void) => frames.push(frame));
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("location", {
    origin,
    get search() {
      return page.search;
    },
    get href() {
      return `${origin}/${page.search}`;
    },
  });
  vi.stubGlobal("history", { state: null, pushState: moveTo, replaceState: moveTo, go: () => {} });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("fetch", fetch);
  return { page, frames, searches, held, mode, results, listed, tagged };
});

const session = async () => {
  const registry = AtomRegistry.make();
  registry.mount(route);
  registry.mount(searchResult);
  await Effect.runPromise(AtomRegistry.getResult(registry, counts, { suspendOnWaiting: true }));
  return {
    registry,
    type: (query: string) => registry.set(route, { _tag: "Type", query }),
    ids: () => Option.map(registry.get(found), (rows) => rows.map(({ id }) => id)),
  };
};

const params = (search: URLSearchParams | undefined) => Object.fromEntries(search ?? []);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  daemon.page.search = "";
  daemon.page.rows = [];
  daemon.frames.length = 0;
  daemon.searches.length = 0;
  daemon.held.length = 0;
  daemon.mode.hold = false;
  daemon.results.splice(0, Infinity, 1);
  daemon.listed.length = 0;
  daemon.tagged.clear();
});

it("typing sends one search once the input has been quiet for 150ms", async () => {
  const { type } = await session();
  for (const query of ["n", "no", "nor", "nort", "north"]) {
    type(query);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(daemon.searches).toEqual([]);
  await vi.advanceTimersByTimeAsync(49);
  expect(daemon.searches).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(daemon.searches.map(params)).toEqual([{ q: "north" }]);
});

it("a response that arrives after a newer query is dropped", async () => {
  daemon.mode.hold = true;
  const { type, ids } = await session();
  type("alpha");
  await vi.advanceTimersByTimeAsync(150);
  type("beta");
  await vi.advanceTimersByTimeAsync(150);
  const [alpha, beta] = daemon.held;
  expect([alpha?.q, beta?.q]).toEqual(["alpha", "beta"]);
  beta?.reply([2]);
  await vi.waitFor(() => expect(ids()).toEqual(Option.some([2])));
  alpha?.reply([1]);
  await vi.advanceTimersByTimeAsync(50);
  expect(ids()).toEqual(Option.some([2]));
});

it.each<[string, string, Record<string, string>]>([
  [
    "chips become filters with the configured tag spelling",
    "in:me from:ada source:personal-mail freeze",
    { q: "freeze", tag: "Me", from: "ada", source: "personal-mail" },
  ],
  ["a chip with no words sends an empty q", "from:ada", { q: "", from: "ada" }],
  ["in:untagged sends Untagged", "in:untagged", { q: "", tag: "Untagged" }],
  ["an unknown in: is searched as text", "in:nowhere", { q: "in:nowhere" }],
])("%s", async (_, query, expected) => {
  const { type } = await session();
  type(query);
  await vi.advanceTimersByTimeAsync(150);
  expect(daemon.searches.map(params)).toEqual([expected]);
});

it("a query of only spaces sends nothing and finds nothing", async () => {
  const { type, ids } = await session();
  type("  ");
  await vi.advanceTimersByTimeAsync(1000);
  expect(daemon.searches).toEqual([]);
  expect(ids()).toEqual(Option.none());
});

it.each<[string, Option.Option<"untagged">, number]>([
  ["Done on an open result opens the next result on screen", Option.none(), 2],
  ["Done inside a group opens the next result in that group", Option.some("untagged"), 3],
])("%s, keeping the query", async (_, group, next) => {
  daemon.results.splice(0, Infinity, 1, 2, 3);
  daemon.tagged.set(2, ["Me"]);
  daemon.listed.push(1, 5);
  const { registry, type } = await session();
  registry.mount(visibleRows("untagged"));
  await Effect.runPromise(
    AtomRegistry.getResult(registry, viewList("untagged"), { suspendOnWaiting: true }),
  );
  type("north");
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => expect(Option.isSome(registry.get(found))).toBe(true));
  registry.set(searchGroup, group);
  registry.set(route, {
    _tag: "Go",
    to: { ...registry.get(route), conversation: Option.some(ConversationId.make(1)) },
  });

  registry.set(dismiss, { act: "Done", target: { id: 1, last_seq: 1, cleared_seq: 0 } });

  await vi.waitFor(() =>
    expect(registry.get(route).conversation).toEqual(Option.some(ConversationId.make(next))),
  );
  expect(registry.get(route).query).toBe("north");
});

const risen = () => {
  const parent = {};
  const rows = [1, 2].map((id, index) => {
    const flags = new Set<string>();
    return {
      flags,
      dataset: { k: String(id) },
      parentElement: parent,
      getBoundingClientRect: () => ({ left: 0, top: index * 50, bottom: index * 50 + 50 }),
      hasAttribute: (name: string) => flags.has(name),
      setAttribute: (name: string) => flags.add(name),
      removeAttribute: (name: string) => flags.delete(name),
      style: { setProperty: () => {}, removeProperty: () => "" },
      getAnimations: () => [],
    };
  });
  daemon.page.rows = rows;
  for (const frame of daemon.frames.splice(0)) frame();
  return rows.filter(({ flags }) => flags.has("data-enter")).map(({ dataset }) => dataset.k);
};

it("switching to a view with the same rows, or leaving a search that found them, still makes the rows rise", async () => {
  daemon.listed.push(1, 2);
  daemon.results.splice(0, Infinity, 1, 2);
  const { registry, type } = await session();
  registry.mount(listMotion);
  registry.mount(viewList("tag:Me"));
  for (const view of ["untagged", "tag:Me"] as const) {
    await Effect.runPromise(
      AtomRegistry.getResult(registry, viewList(view), { suspendOnWaiting: true }),
    );
  }
  risen();

  registry.set(route, { _tag: "Go", to: { ...registry.get(route), view: "tag:Me" } });
  expect(risen()).toEqual(["1", "2"]);

  type("north");
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => expect(Option.isSome(registry.get(found))).toBe(true));
  risen();
  type("");
  expect(risen()).toEqual(["1", "2"]);
});
