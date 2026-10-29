import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { ConversationId, chips, href, parse, type Route, writeKind } from "./Route.ts";

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

describe("chips", () => {
  it.each([
    ["", []],
    ["from:ada", []],
    ["from:ada ", ["from:ada"]],
    ["in:Me source:gws invoice", ["in:Me", "source:gws"]],
    ["xfrom:ada invoice", []],
  ])("finds closed field tokens in %j", (query, expected) => {
    expect(chips(query)).toEqual(expected);
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
    ["later keystroke", at("cleared", "a"), at("cleared", "ab"), "replace"],
    ["deleting a character", at("cleared", "ab"), at("cleared", "a"), "replace"],
    ["clearing the query", at("cleared", "a"), at("cleared"), "push"],
    ["chip added", at("untagged", "from:ada"), at("untagged", "from:ada "), "push"],
    ["typing after a chip", at("untagged", "from:ada "), at("untagged", "from:ada x"), "replace"],
    ["chip removed", at("untagged", "from:ada x"), at("untagged", "x"), "push"],
    ["open result while searching", at("untagged", "abc"), at("untagged", "abc", 9), "push"],
  ] as const)("%s -> %s", (_, previous, next, expected) => {
    expect(writeKind(previous, next)).toBe(expected);
  });
});
