import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import {
  ConversationId,
  destination,
  href,
  type Navigation,
  parse,
  type Route,
  writeKind,
} from "./Route.ts";

const at = (view: Route["view"], query = "", conversation?: number): Route => ({
  view,
  query,
  conversation:
    conversation === undefined ? Option.none() : Option.some(ConversationId.make(conversation)),
});

describe("route URL", () => {
  it.each([
    ["", at("untagged")],
    ["?v=untagged", at("untagged")],
    ["?v=cleared", at("cleared")],
    ["?v=tag%3AOn-call", at("tag:On-call")],
    ["?v=tag:Me&q=from%3Aada+invoice&c=42", at("tag:Me", "from:ada invoice", 42)],
    ["?q=%C3%A9t%C3%A9+%26+more", at("untagged", "été & more")],
    ["?c=7&v=cleared&unknown=1", at("cleared", "", 7)],
  ])("decodes %j", (search, expected) => {
    expect(parse(search)).toEqual(expected);
  });

  it.each([
    ["?v=nope", at("untagged")],
    ["?v=tag", at("untagged")],
    ["?v=tag:", at("untagged")],
    ["?v=", at("untagged")],
    ["?c=abc", at("untagged")],
    ["?c=0", at("untagged")],
    ["?c=-3", at("untagged")],
    ["?c=1.5", at("untagged")],
    ["?v=bogus&q=kept&c=x", at("untagged", "kept")],
  ])("falls back to the default for invalid %j", (search, expected) => {
    expect(parse(search)).toEqual(expected);
  });

  it.each([
    [at("untagged"), "/"],
    [at("cleared"), "/?v=cleared"],
    [at("tag:On-call"), "/?v=tag%3AOn-call"],
    [at("untagged", "", 42), "/?c=42"],
    [at("cleared", "été & more", 3), "/?v=cleared&q=%C3%A9t%C3%A9+%26+more&c=3"],
  ])("encodes %j without defaults and round-trips", (route, expected) => {
    expect(href(route)).toBe(expected);
    expect(parse(new URL(expected, "http://127.0.0.1").search)).toEqual(route);
  });
});

const go = (to: Route): Navigation => ({ _tag: "Go", to });
const type = (query: string): Navigation => ({ _tag: "Type", query });

describe("history write kind", () => {
  it.each([
    ["same route", at("untagged", "abc"), go(at("untagged", "abc")), "none"],
    ["view change", at("untagged"), go(at("cleared")), "push"],
    ["view link while searching", at("untagged", "abc"), go(at("cleared")), "push"],
    ["current view link while searching", at("untagged", "abc"), go(at("untagged")), "push"],
    ["current view link over a result", at("untagged", "abc", 9), go(at("untagged")), "push"],
    ["open conversation", at("untagged"), go(at("untagged", "", 4)), "push"],
    ["switch conversation", at("untagged", "", 4), go(at("untagged", "", 5)), "push"],
    ["close conversation", at("untagged", "", 4), go(at("untagged")), "push"],
    ["first keystroke", at("cleared"), type("a"), "push"],
    ["first keystroke over a conversation", at("cleared", "", 4), type("a"), "push"],
    ["later keystroke", at("cleared", "a"), type("ab"), "replace"],
    ["deleting a character", at("cleared", "ab"), type("a"), "replace"],
    ["clearing the query", at("cleared", "a"), type(""), "leave"],
    ["clearing the query over a result", at("cleared", "a", 9), type(""), "leave"],
    ["chip added", at("untagged", "from:ada"), type("from:ada "), "replace"],
    ["typing after a chip", at("untagged", "from:ada "), type("from:ada x"), "replace"],
    ["chip removed", at("untagged", "from:ada x"), type("x"), "replace"],
    ["editing over a result", at("untagged", "abc", 9), type("abcd"), "replace"],
    ["open result while searching", at("untagged", "abc"), go(at("untagged", "abc", 9)), "push"],
  ] as const)("%s", (_, previous, navigation, expected) => {
    expect(writeKind(previous, navigation)).toBe(expected);
  });

  it.each([
    ["typing closes the open conversation", at("cleared", "", 4), type("a"), at("cleared", "a")],
    [
      "clearing keeps the route's conversation",
      at("cleared", "a", 9),
      type(""),
      at("cleared", "", 9),
    ],
    [
      "a link goes exactly where it points",
      at("untagged", "abc", 9),
      go(at("untagged")),
      at("untagged"),
    ],
  ] as const)("%s", (_, previous, navigation, expected) => {
    expect(destination(previous, navigation)).toEqual(expected);
  });
});
