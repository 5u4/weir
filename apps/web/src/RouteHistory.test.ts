import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationId, href, type Navigation, route } from "./Route.ts";

const origin = "http://127.0.0.1:9347";

const fakeBrowser = (start: string) => {
  const entries: Array<{ url: string; state: unknown }> = [{ url: start, state: null }];
  let index = 0;
  const pendingMoves: Array<number> = [];
  const popstate = new Set<() => void>();
  const at = () => entries[index] ?? { url: "/", state: null };
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
  vi.stubGlobal("addEventListener", (_: string, listener: () => void) => popstate.add(listener));
  vi.stubGlobal("removeEventListener", (_: string, listener: () => void) =>
    popstate.delete(listener),
  );
  return {
    url: () => at().url,
    canGoBackTo: () => entries.slice(0, index).map(({ url }) => url),
    back: () => pendingMoves.push(-1),
    deliverHistoryMoves: () => {
      for (const delta of pendingMoves.splice(0)) {
        index = Math.min(Math.max(index + delta, 0), entries.length - 1);
        for (const listener of popstate) listener();
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
