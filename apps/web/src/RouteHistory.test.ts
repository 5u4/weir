import type { Counts } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { keys } from "./Keys.ts";
import { awaitArrivals } from "./Morph.ts";
import {
  ConversationId,
  capCounts,
  href,
  type Navigation,
  route,
  searchOpen,
  statusOpen,
} from "./Route.ts";
import { searchGroup } from "./Weir.ts";

vi.hoisted(() => vi.stubGlobal("location", { origin: "http://127.0.0.1:9347" }));

const origin = "http://127.0.0.1:9347";

type Listener = (event: unknown) => void;
type Phase = "capture" | "bubble";

const phaseOf = (options?: boolean | { readonly capture?: boolean }): Phase =>
  (typeof options === "boolean" ? options : options?.capture === true) ? "capture" : "bubble";

const fakeWindow = () => {
  const listeners = new Map<string, Record<Phase, Set<Listener>>>();
  const on = (type: string) => {
    const existing = listeners.get(type);
    if (existing !== undefined) return existing;
    const created = { capture: new Set<Listener>(), bubble: new Set<Listener>() };
    listeners.set(type, created);
    return created;
  };
  vi.stubGlobal("addEventListener", (type: string, listener: Listener, options?: boolean) => {
    on(type)[phaseOf(options)].add(listener);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: Listener, options?: boolean) => {
    on(type)[phaseOf(options)].delete(listener);
  });
  return (type: string, event: object) => {
    const { capture, bubble } = on(type);
    const invoked = [...capture, ...bubble];
    for (const listener of invoked) listener({ type, ...event });
  };
};

const fakeBrowser = (start: string) => {
  const entries: Array<{ url: string; state: unknown }> = [{ url: start, state: null }];
  let index = 0;
  const pendingMoves: Array<number> = [];
  const dispatch = fakeWindow();
  const at = () => entries[index] ?? { url: "/", state: null };
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("location", {
    get search() {
      return new URL(at().url, origin).search;
    },
    get href() {
      return new URL(at().url, origin).href;
    },
  });
  vi.stubGlobal("history", {
    get state() {
      return at().state;
    },
    pushState: (state: unknown, _: string, url: string) => {
      entries.splice(index + 1, entries.length, { url, state });
      index += 1;
    },
    replaceState: (state: unknown, _: string, url: string) => {
      entries[index] = { url, state };
    },
    go: (delta: number) => pendingMoves.push(delta),
    back: () => pendingMoves.push(-1),
  });
  return {
    dispatch,
    url: () => at().url,
    canGoBackTo: () => entries.slice(0, index).map(({ url }) => url),
    canGoForwardTo: () => entries.slice(index + 1).map(({ url }) => url),
    back: () => pendingMoves.push(-1),
    deliverHistoryMoves: () => {
      for (const delta of pendingMoves.splice(0)) {
        index = Math.min(Math.max(index + delta, 0), entries.length - 1);
        dispatch("popstate", { hasUAVisualTransition: false });
      }
    },
  };
};

const session = (start: string) => {
  const browser = fakeBrowser(start);
  const registry = AtomRegistry.make();
  registry.mount(route);
  return {
    browser,
    registry,
    navigate: (navigation: Navigation) => {
      registry.set(route, navigation);
      browser.deliverHistoryMoves();
    },
    shown: () => href(registry.get(route)),
  };
};

const open = (query: string, conversation: number): Navigation => ({
  _tag: "Go",
  to: { view: "untagged", query, conversation: Option.some(ConversationId.make(conversation)) },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("leaving search through browser history", () => {
  it("clearing the query returns to the pre-search entry", () => {
    const { browser, navigate, shown } = session("/?c=7");
    navigate({ _tag: "Type", query: "a" });
    navigate({ _tag: "Type", query: "ab" });
    navigate({ _tag: "Type", query: "" });
    expect(browser.url()).toBe("/?c=7");
    expect(shown()).toBe("/?c=7");
    expect(browser.canGoBackTo()).toEqual([]);
  });

  it("clearing after opening results returns to the pre-search entry, and Back does not reopen search", () => {
    const { browser, navigate, shown } = session("/?c=7");
    navigate({ _tag: "Type", query: "a" });
    navigate(open("a", 9));
    navigate(open("a", 11));
    expect(browser.url()).toBe("/?q=a&c=11");
    navigate({ _tag: "Type", query: "" });
    expect(browser.url()).toBe("/?c=7");
    expect(shown()).toBe("/?c=7");
    expect(browser.canGoBackTo()).toEqual([]);
  });

  it("clearing after Back from a result still returns to the pre-search entry", () => {
    const { browser, navigate, shown } = session("/?c=7");
    navigate({ _tag: "Type", query: "a" });
    navigate(open("a", 9));
    browser.back();
    browser.deliverHistoryMoves();
    expect(shown()).toBe("/?q=a");
    navigate({ _tag: "Type", query: "" });
    expect(browser.url()).toBe("/?c=7");
    expect(browser.canGoBackTo()).toEqual([]);
  });

  it("a search loaded from a URL has no pre-search entry, so clearing replaces it with the view", () => {
    const { browser, navigate, shown } = session("/?v=cleared&q=a&c=3");
    navigate({ _tag: "Type", query: "" });
    expect(browser.url()).toBe("/?v=cleared");
    expect(shown()).toBe("/?v=cleared");
    expect(browser.canGoBackTo()).toEqual([]);
  });
});

describe("navigating closes Status", () => {
  it.each<[string, Navigation]>([
    [
      "a view link",
      { _tag: "Go", to: { view: "cleared", query: "", conversation: Option.none() } },
    ],
    [
      "the current view link",
      { _tag: "Go", to: { view: "untagged", query: "", conversation: Option.none() } },
    ],
    ["typing a search", { _tag: "Type", query: "a" }],
    ["typing the same search", { _tag: "Type", query: "" }],
  ])("%s", (_, navigation) => {
    const { registry, navigate } = session("/");
    registry.mount(statusOpen);
    registry.set(statusOpen, true);
    navigate(navigation);
    expect(registry.get(statusOpen)).toBe(false);
  });
});

type Running = {
  readonly types: ReadonlyArray<string>;
  readonly finished: Promise<void>;
  readonly end: () => void;
  skipped: boolean;
};

const deferredTransitions = () => {
  const types: Array<ReadonlyArray<string>> = [];
  const updates: Array<() => Promise<void>> = [];
  const started: Array<Running> = [];
  const running: Array<Running> = [];
  const rises: Array<string> = [];
  const article = {
    setAttribute: (_: string, rise: string) => rises.push(rise),
    removeAttribute: () => {},
    getAnimations: () => [],
  };
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("document", {
    hidden: false,
    querySelector: () => article,
    startViewTransition: (options: {
      readonly update: () => Promise<void>;
      readonly types: ReadonlyArray<string>;
    }) => {
      for (const live of running.splice(0)) {
        live.skipped = true;
        live.end();
      }
      types.push(options.types);
      const updated = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const entry: Running = {
        types: options.types,
        finished: finished.promise,
        end: finished.resolve,
        skipped: false,
      };
      started.push(entry);
      running.push(entry);
      updates.push(() =>
        options
          .update()
          .then(updated.resolve)
          .then(() => updated.promise),
      );
      return {
        ready: Promise.resolve(),
        updateCallbackDone: updated.promise,
        finished: finished.promise,
        skipTransition: () => {
          entry.skipped = true;
          entry.end();
        },
      };
    },
  });
  const runUpdates = async () => {
    for (let update = updates.shift(); update !== undefined; update = updates.shift()) {
      await update();
    }
  };
  const finishAll = async () => {
    for (const live of running.splice(0)) {
      live.end();
      await live.finished;
    }
  };
  return {
    types,
    started,
    rises,
    runUpdates,
    finishAll,
    runAll: async () => {
      await runUpdates();
      await finishAll();
    },
  };
};

describe("writes while a view transition is pending", () => {
  it("Escape in the frame that opens a conversation leaves it closed", async () => {
    const { browser, registry, shown } = session("/");
    const transitions = deferredTransitions();
    registry.set(route, open("", 7));
    registry.set(route, {
      _tag: "Go",
      to: { view: "untagged", query: "", conversation: Option.none() },
    });
    await transitions.runAll();
    expect(shown()).toBe("/");
    expect(browser.url()).toBe("/");
    expect(transitions.types).toEqual([
      ["mode", "open"],
      ["mode", "close"],
    ]);
  });

  it("Escape pressed before the opening frame is captured closes the conversation", async () => {
    const { browser, registry, shown } = session("/");
    const transitions = deferredTransitions();
    vi.stubGlobal("HTMLElement", class {});
    registry.mount(keys);
    registry.set(route, open("", 7));
    browser.dispatch("keydown", {
      key: "Escape",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: {},
      preventDefault: () => {},
    });
    await transitions.runAll();
    expect(shown()).toBe("/");
    expect(browser.url()).toBe("/");
  });

  it("typing while the opened conversation is still loading keeps every character", async () => {
    const { registry } = session("/?q=x");
    const transitions = deferredTransitions();
    const reached = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    onTestFinished(
      awaitArrivals(() => {
        reached.resolve();
        return loaded.promise;
      }),
    );
    registry.set(route, open("x", 7));
    const running = transitions.runAll();
    await reached.promise;
    for (const query of ["a", "ab", "abc"]) {
      registry.set(route, { _tag: "Type", query });
      expect(registry.get(route).query).toBe(query);
    }
    loaded.resolve();
    await running;
    expect(registry.get(route).query).toBe("abc");
  });

  it("typing before the opening frame is captured lands immediately", async () => {
    const { browser, registry } = session("/?q=x");
    const transitions = deferredTransitions();
    registry.set(route, open("x", 7));
    browser.dispatch("beforeinput", {});
    registry.set(route, { _tag: "Type", query: "xy" });
    expect(registry.get(route).query).toBe("xy");
    await transitions.runAll();
    expect(registry.get(route).query).toBe("xy");
    expect(browser.url()).toBe("/?q=xy");
  });

  it("Back before the opening frame is captured wins over the open", async () => {
    const { browser, registry, navigate, shown } = session("/");
    navigate({ _tag: "Go", to: { view: "cleared", query: "", conversation: Option.none() } });
    const transitions = deferredTransitions();
    registry.set(route, {
      _tag: "Go",
      to: { view: "cleared", query: "", conversation: Option.some(ConversationId.make(7)) },
    });
    browser.back();
    browser.deliverHistoryMoves();
    await transitions.runAll();
    expect(shown()).toBe("/");
    expect(browser.url()).toBe("/");
    expect(browser.canGoForwardTo()).toEqual(["/?v=cleared"]);
  });

  it("Back while the opened conversation is still loading wins over a click made before it", async () => {
    const { browser, registry, shown } = session("/");
    const transitions = deferredTransitions();
    const reached = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<void>();
    onTestFinished(
      awaitArrivals(() => {
        reached.resolve();
        return loaded.promise;
      }),
    );
    registry.set(route, open("", 7));
    const running = transitions.runAll();
    await reached.promise;
    registry.set(route, open("", 9));
    browser.back();
    browser.deliverHistoryMoves();
    loaded.resolve();
    await running;
    await transitions.runAll();
    expect(browser.url()).toBe("/");
    expect(shown()).toBe("/");
    expect(browser.canGoForwardTo()).toEqual(["/?c=7"]);
  });
});

const counts = (me: number, cleared = 0): Counts => ({
  unread: me,
  tags: [{ name: "Me", unread: me, open: me, senders: [] }],
  untagged: { unread: 0, open: 0, senders: [] },
  cleared,
});

const notch = (start: string) => {
  const opened = session(start);
  opened.registry.mount(capCounts);
  opened.registry.mount(searchOpen);
  opened.registry.set(capCounts, counts(2));
  return { ...opened, transitions: deferredTransitions() };
};

const shownCount = (registry: ReturnType<typeof session>["registry"]) =>
  Option.map(registry.get(capCounts), ({ unread }) => unread);

describe("notch ticks", () => {
  it("a count change ticks, and the cap keeps the old count until the new snapshot", async () => {
    const { registry, transitions } = notch("/");
    registry.set(capCounts, counts(1, 1));
    expect(shownCount(registry)).toEqual(Option.some(2));
    await transitions.runAll();
    expect(shownCount(registry)).toEqual(Option.some(1));
    expect(transitions.types).toEqual([["tick"]]);
  });

  it("a refetch with the same numbers does not tick", async () => {
    const { registry, transitions } = notch("/");
    registry.set(capCounts, counts(2));
    await transitions.runAll();
    expect(transitions.types).toEqual([]);
  });

  it("picking another view does not tick", async () => {
    const { navigate, shown, transitions } = notch("/");
    navigate({ _tag: "Go", to: { view: "cleared", query: "", conversation: Option.none() } });
    await transitions.runAll();
    expect(shown()).toBe("/?v=cleared");
    expect(transitions.types).toEqual([]);
  });

  it("typing never ticks, even when it changes the notch's form", async () => {
    const { navigate, shown, transitions } = notch("/?q=a");
    navigate({ _tag: "Type", query: "" });
    await transitions.runAll();
    expect(shown()).toBe("/");
    expect(transitions.types).toEqual([]);
  });

  it("does not tick under reduced motion", async () => {
    const { registry, transitions } = notch("/");
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    registry.set(capCounts, counts(1));
    expect(shownCount(registry)).toEqual(Option.some(1));
    expect(transitions.types).toEqual([]);
  });

  it("opening and leaving search tick", async () => {
    const { browser, registry, navigate, shown, transitions } = notch("/");
    registry.set(searchOpen, true);
    await transitions.runAll();
    navigate({ _tag: "Type", query: "abc" });
    registry.set(route, { _tag: "Leave" });
    await transitions.runAll();
    browser.deliverHistoryMoves();
    expect(registry.get(searchOpen)).toBe(false);
    expect(shown()).toBe("/");
    expect(browser.url()).toBe("/");
    expect(transitions.types).toEqual([["tick"], ["tick"]]);
  });

  it("Escape out of a grouped search keeps the group on screen until the new snapshot", async () => {
    const { browser, registry, navigate, shown, transitions } = notch("/");
    vi.stubGlobal("HTMLElement", class {});
    registry.mount(keys);
    registry.mount(searchGroup);
    registry.set(searchOpen, true);
    await transitions.runAll();
    navigate({ _tag: "Type", query: "abc" });
    registry.set(searchGroup, Option.some("untagged"));
    browser.dispatch("keydown", {
      key: "Escape",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      target: {},
      preventDefault: () => {},
    });
    const held = { group: registry.get(searchGroup), shown: shown() };
    await transitions.runUpdates();
    const updated = { group: registry.get(searchGroup), shown: shown() };
    await transitions.finishAll();
    expect(held).toEqual({ group: Option.some("untagged"), shown: "/?q=abc" });
    expect(updated).toEqual({ group: Option.none(), shown: "/" });
    expect(transitions.types).toEqual([["tick"], ["tick"]]);
  });

  it("a tick applies directly while a view transition is still playing", async () => {
    const { registry, transitions } = notch("/");
    registry.set(route, open("", 7));
    await transitions.runUpdates();
    registry.set(capCounts, counts(1));
    expect(shownCount(registry)).toEqual(Option.some(1));
    await transitions.finishAll();
    expect(transitions.types).toEqual([["mode", "open"]]);
  });

  it("a tick waits for a view transition's update, then applies without its own", async () => {
    const { registry, transitions } = notch("/");
    registry.set(route, open("", 7));
    registry.set(capCounts, counts(1));
    expect(shownCount(registry)).toEqual(Option.some(2));
    await transitions.runAll();
    expect(shownCount(registry)).toEqual(Option.some(1));
    expect(transitions.types).toEqual([["mode", "open"]]);
  });

  it("opening a conversation skips a running tick", async () => {
    const { registry, transitions } = notch("/");
    registry.set(capCounts, counts(1));
    await transitions.runUpdates();
    registry.set(route, open("", 7));
    await transitions.runAll();
    expect(transitions.types).toEqual([["tick"], ["mode", "open"]]);
    expect(transitions.started[0]?.skipped).toBe(true);
    expect(registry.get(route).conversation).toEqual(Option.some(ConversationId.make(7)));
  });
});

const heldArrivals = () => {
  const held = new Map<ConversationId, PromiseWithResolvers<void>>();
  onTestFinished(
    awaitArrivals((id) => {
      const arrived = Promise.withResolvers<void>();
      held.set(id, arrived);
      return arrived.promise;
    }),
  );
  return (id: number) => {
    const arrived = held.get(ConversationId.make(id));
    arrived?.resolve();
    return arrived?.promise;
  };
};

describe("the switch rise", () => {
  it("plays after counts refetch while the next conversation loads", async () => {
    const { navigate, registry, transitions } = notch("/?c=7");
    const arrive = heldArrivals();
    navigate(open("", 9));
    registry.set(capCounts, counts(2));
    registry.set(capCounts, counts(1));
    await transitions.runAll();
    await arrive(9);
    expect(transitions.types).toEqual([["tick"]]);
    expect(transitions.rises).toEqual(["switch"]);
  });

  it("plays after a tick's update when the conversation loads while the tick is pending", async () => {
    const { navigate, registry, transitions } = notch("/?c=7");
    const arrive = heldArrivals();
    navigate(open("", 9));
    registry.set(capCounts, counts(1));
    await arrive(9);
    expect(transitions.rises).toEqual([]);
    await transitions.runAll();
    expect(transitions.types).toEqual([["tick"]]);
    expect(transitions.rises).toEqual(["switch"]);
  });

  it("is dropped when the reader moves on before the conversation loads", async () => {
    const { navigate, transitions } = notch("/?c=7");
    const arrive = heldArrivals();
    navigate(open("", 9));
    navigate(open("", 11));
    await arrive(9);
    expect(transitions.rises).toEqual([]);
    await arrive(11);
    expect(transitions.rises).toEqual(["switch"]);
  });
});
