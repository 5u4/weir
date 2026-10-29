import type { Row } from "@weir/daemon/Api";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, expect, it, vi } from "vitest";
import { shown } from "./Rows.ts";
import { dismiss, intents, viewList } from "./Weir.ts";

const daemon = vi.hoisted(() => {
  const rows = new Map<number, Row>();
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
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
    return new Response(null, { status: 404 });
  };
  vi.stubGlobal("location", { origin: "http://weir.test" });
  vi.stubGlobal("fetch", fetch);
  return { rows };
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
  from: { name: "Ada Lovelace", address: "ada@example.com" },
  preview: "Ada: hello",
  senders: [{ name: "Ada Lovelace", address: "ada@example.com" }],
});

const settled = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }));

afterEach(() => daemon.rows.clear());

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
