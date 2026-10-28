import { Rule } from "@weir/contract/Rule";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { match } from "./Match.ts";

const decodeRule = Schema.decodeUnknownSync(Rule, { onExcessProperty: "error" });

const input = {
  source: "personal-mail",
  title: "Deploy failed",
  from: { name: "GitHub", address: "notifications@github.com" },
  fromMe: false,
  raw: {
    "a/b": "slash",
    "m~n": "tilde",
    "~1": "literal escape",
    "@odata.type": "#microsoft.graph.chatMessage",
    labelIds: ["INBOX", "CATEGORY_UPDATES"],
    empty: [],
    payload: {
      headers: [
        { name: "List-Unsubscribe", value: "<mailto:x@example.com>" },
        { name: "Subject", value: "Deploy failed" },
      ],
    },
  },
};

const matches = (rule: unknown, root: unknown = input) => match(decodeRule(rule), root);

describe("match pointers", () => {
  it.each([
    ["/raw/a~1b", "slash"],
    ["/raw/m~0n", "tilde"],
    ["/raw/~01", "literal escape"],
    ["/raw/@odata.type", "#microsoft.graph.chatMessage"],
    ["/raw/labelIds/1", "CATEGORY_UPDATES"],
  ])("resolves %s", (target, is) => {
    expect(matches({ type: "eq", target, is })).toBe(true);
  });

  it('"" targets the whole root', () => {
    expect(matches({ type: "eq", target: "", is: "INBOX" }, "INBOX")).toBe(true);
  });

  it("rejects a pointer with a dangling escape at decode time", () => {
    expect(() => decodeRule({ type: "exists", target: "/raw/a~2" })).toThrow();
  });

  it.each(["/raw/labelIds/length", "/raw/labelIds/01", "/raw/labelIds/-", "/raw/labelIds/2"])(
    "does not resolve the non-index array token %s",
    (target) => {
      expect(matches({ type: "exists", target })).toBe(false);
      expect(matches({ type: "eq", target, is: 2 })).toBe(false);
    },
  );

  it("resolves an object key named length", () => {
    expect(matches({ type: "eq", target: "/raw/length", is: 3 }, { raw: { length: 3 } })).toBe(
      true,
    );
  });
});

describe("match on a missing path", () => {
  it.each([
    { type: "eq", target: "/raw/nope", is: null },
    { type: "regex", target: "/raw/nope", regex: "" },
    { type: "exists", target: "/raw/nope" },
    { type: "exists", target: "/title/length" },
    { type: "some", target: "/raw/nope", rule: { type: "exists", target: "" } },
    { type: "every", target: "/raw/nope", rule: { type: "exists", target: "" } },
    { type: "every", target: "/title", rule: { type: "exists", target: "" } },
  ])("$type at $target is false", (rule) => {
    expect(matches(rule)).toBe(false);
  });

  it("not over a missing path is true", () => {
    expect(matches({ type: "not", rule: { type: "exists", target: "/raw/nope" } })).toBe(true);
  });
});

describe("match quantifiers", () => {
  const header = (name: string) => ({
    type: "some",
    target: "/raw/payload/headers",
    rule: { type: "eq", target: "/name", is: name },
  });

  it("some evaluates the inner rule with each element as the root", () => {
    expect(matches(header("List-Unsubscribe"))).toBe(true);
    expect(matches(header("Cc"))).toBe(false);
  });

  it("every requires all elements to match", () => {
    const rule = (regex: string) => ({
      type: "every",
      target: "/raw/labelIds",
      rule: { type: "regex", target: "", regex },
    });
    expect(matches(rule("^[A-Z_]+$"))).toBe(true);
    expect(matches(rule("^CATEGORY_"))).toBe(false);
  });

  it("every over an empty array is true and some is false", () => {
    const inner = { type: "eq", target: "", is: "x" };
    expect(matches({ type: "every", target: "/raw/empty", rule: inner })).toBe(true);
    expect(matches({ type: "some", target: "/raw/empty", rule: inner })).toBe(false);
  });
});

describe("match combinators", () => {
  const isGithub = { type: "regex", target: "/from/address", regex: "@github\\.com$" };
  const isPromo = {
    type: "some",
    target: "/raw/labelIds",
    rule: { type: "eq", target: "", is: "CATEGORY_PROMOTIONS" },
  };

  it("nests and, or, and not", () => {
    expect(matches({ type: "and", rules: [isGithub, { type: "not", rule: isPromo }] })).toBe(true);
    expect(matches({ type: "and", rules: [isGithub, isPromo] })).toBe(false);
    expect(matches({ type: "or", rules: [isPromo, isGithub] })).toBe(true);
    expect(matches({ type: "or", rules: [isPromo] })).toBe(false);
    expect(matches({ type: "not", rule: { type: "or", rules: [isPromo, isGithub] } })).toBe(false);
  });

  it("and over no rules is true and or over no rules is false", () => {
    expect(matches({ type: "and", rules: [] })).toBe(true);
    expect(matches({ type: "or", rules: [] })).toBe(false);
  });

  it("regex honours flags and only matches strings", () => {
    expect(matches({ type: "regex", target: "/title", regex: "deploy" })).toBe(false);
    expect(matches({ type: "regex", target: "/title", regex: "deploy", flags: "i" })).toBe(true);
    expect(matches({ type: "regex", target: "/fromMe", regex: "false" })).toBe(false);
  });

  it("eq compares scalars strictly", () => {
    expect(matches({ type: "eq", target: "/fromMe", is: false })).toBe(true);
    expect(matches({ type: "eq", target: "/fromMe", is: "false" })).toBe(false);
  });
});
