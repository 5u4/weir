import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, expect, it, vi } from "vitest";
import { closedUi } from "./Blocks.ts";
import { hitKey } from "./Hits.ts";
import { hitAt, jumpTo, landing, readerUi, searchHits } from "./Reading.ts";
import { ConversationId } from "./Route.ts";
import { conversation } from "./Weir.ts";

const daemon = vi.hoisted(() => {
  const party = { name: "Lisa Chen", address: "lisa.chen@northwind.example", me: false };
  const state = {
    bodies: new Map<number, string>(),
    digests: [] as Array<{ id: number; from_seq: number; to_seq: number; seqs: Array<number> }>,
  };
  const item = ([seq, body]: [number, string]) => ({
    seq,
    conversation_id: 1,
    container_name: "INBOX",
    occurred_at: `2026-10-25T09:${String(seq).padStart(2, "0")}:00.000Z`,
    title: null,
    from: party,
    from_me: false,
    link: null,
    body,
    body_new: body,
    raw: null,
    deleted_at: null,
  });
  const detail = () => ({
    id: 1,
    source: "gmail",
    title: "#1",
    first_at: "2026-10-25T09:00:00.000Z",
    last_at: "2026-10-25T09:00:00.000Z",
    tags: [],
    open: null,
    state: { seen_seq: 0, cleared_seq: 0, muted: false, state: "unread" },
    items: [...state.bodies].map(item),
    digests: state.digests.map(({ id, from_seq, to_seq, seqs }) => ({
      id,
      conversation_id: 1,
      from_seq,
      to_seq,
      headline: "Cutover",
      topics: [{ title: "Plan", state: "open", body: "Dates agreed.", seqs }],
      trigger: "auto",
      ai_profile: "fake-ai",
      created_at: "2026-10-25T16:00:00.000Z",
    })),
    digest: { backlog: null, earlier: null, now: null, last_failure: null },
  });
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/conversations/1") return Response.json(detail());
    if (url.pathname === "/counts") {
      return Response.json({
        unread: 0,
        tags: [],
        untagged: { unread: 0, open: 0, senders: [] },
        cleared: 0,
      });
    }
    return new Response(null, { status: 404 });
  };
  vi.stubGlobal("location", { origin: "http://weir.test", search: "?c=1&q=uat" });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
  vi.stubGlobal("requestAnimationFrame", () => 0);
  return { state };
});

afterEach(() => {
  daemon.state.bodies.clear();
  daemon.state.digests.length = 0;
});

const id = ConversationId.make(1);

const opened = async (bodies: ReadonlyArray<readonly [number, string]>) => {
  for (const [seq, body] of bodies) daemon.state.bodies.set(seq, body);
  const registry = AtomRegistry.make();
  registry.mount(conversation(id));
  registry.mount(landing(id));
  registry.mount(hitAt(id));
  registry.mount(readerUi(id));
  await Effect.runPromise(
    AtomRegistry.getResult(registry, conversation(id), { suspendOnWaiting: true }),
  );
  return registry;
};

const shown = (registry: AtomRegistry.AtomRegistry) =>
  Option.getOrElse(registry.get(searchHits(id)), () => []);

const refreshed = (registry: AtomRegistry.AtomRegistry, total: number) => {
  registry.refresh(conversation(id));
  return vi.waitFor(() => expect(shown(registry)).toHaveLength(total));
};

const selected = (registry: AtomRegistry.AtomRegistry) => {
  const hits = shown(registry);
  const at = registry.get(hitAt(id));
  const hit = hits[at];
  return `${at + 1} / ${hits.length} ${hit === undefined ? "none" : hitKey(hit)}`;
};

it("keeps the selected hit when hits before it disappear", async () => {
  const registry = await opened([
    [1, "UAT starts Monday."],
    [2, "UAT data loaded."],
    [3, "UAT sign-off Friday."],
    [4, "UAT passed."],
  ]);
  registry.set(jumpTo, { id, at: 2, smooth: false });
  expect(selected(registry)).toBe("3 / 4 i:3");

  daemon.state.bodies.set(1, "Kickoff Monday.");
  await refreshed(registry, 3);

  expect(selected(registry)).toBe("2 / 3 i:3");
  registry.dispose();
});

it("moves to the nearest remaining hit, revealed, when the selected one disappears", async () => {
  daemon.state.digests.push({ id: 9, from_seq: 1, to_seq: 2, seqs: [1, 2] });
  const registry = await opened([
    [1, "UAT starts Monday."],
    [2, "UAT data loaded."],
    [3, "UAT sign-off Friday."],
    [4, "UAT passed."],
    [5, "UAT closed."],
  ]);
  registry.set(jumpTo, { id, at: 4, smooth: false });
  registry.set(readerUi(id), closedUi);
  expect(selected(registry)).toBe("5 / 5 i:5");

  for (const seq of [3, 4, 5]) daemon.state.bodies.set(seq, "Done.");
  await refreshed(registry, 2);

  expect(selected(registry)).toBe("2 / 2 i:2");
  await vi.waitFor(() => expect([...registry.get(readerUi(id)).originals]).toEqual(["9:0"]));
  registry.dispose();
});
