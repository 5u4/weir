import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { ConversationId, href, parse, type Route, writeKind } from "./Route.ts";

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

describe("history write kind", () => {
  it.each([
    ["same route", at("untagged", "abc"), at("untagged", "abc"), "none"],
    ["view change", at("untagged"), at("cleared"), "push"],
    ["view link while searching", at("untagged", "abc"), at("cleared"), "push"],
    ["open conversation", at("untagged"), at("untagged", "", 4), "push"],
    ["switch conversation", at("untagged", "", 4), at("untagged", "", 5), "push"],
    ["close conversation", at("untagged", "", 4), at("untagged"), "push"],
    ["first keystroke", at("cleared"), at("cleared", "a"), "push"],
    ["first keystroke over a conversation", at("cleared", "", 4), at("cleared", "a"), "push"],
    ["later keystroke", at("cleared", "a"), at("cleared", "ab"), "replace"],
    ["deleting a character", at("cleared", "ab"), at("cleared", "a"), "replace"],
    ["clearing the query", at("cleared", "a"), at("cleared"), "leave"],
    ["clearing the query over a result", at("cleared", "a", 9), at("cleared", "", 9), "leave"],
    ["chip added", at("untagged", "from:ada"), at("untagged", "from:ada "), "replace"],
    ["typing after a chip", at("untagged", "from:ada "), at("untagged", "from:ada x"), "replace"],
    ["chip removed", at("untagged", "from:ada x"), at("untagged", "x"), "replace"],
    ["editing over a result", at("untagged", "abc", 9), at("untagged", "abcd"), "replace"],
    ["open result while searching", at("untagged", "abc"), at("untagged", "abc", 9), "push"],
  ] as const)("%s -> %s", (_, previous, next, expected) => {
    expect(writeKind(previous, next)).toBe(expected);
  });
});
