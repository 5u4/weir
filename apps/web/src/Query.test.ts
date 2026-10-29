import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import {
  type Field,
  fieldOf,
  parseQuery,
  type Query,
  queryOf,
  queryText,
  searchParams,
  typed,
} from "./Query.ts";

const tags = ["Me", "On-call", "GitHub"];

describe("parseQuery", () => {
  it.each<[string, string, Query]>([
    ["plain words", "freeze  deploy ", { text: "freeze deploy", chips: [] }],
    ["from:", "from:ada freeze", { text: "freeze", chips: [{ key: "from", value: "ada" }] }],
    [
      "source: keeps the id as written",
      "source:personal-mail",
      { text: "", chips: [{ key: "source", value: "personal-mail" }] },
    ],
    [
      "in: sends the configured spelling",
      "in:me x",
      { text: "x", chips: [{ key: "in", value: "Me" }] },
    ],
    ["in: any case", "IN:on-CALL", { text: "", chips: [{ key: "in", value: "On-call" }] }],
    ["in:untagged", "in:untagged", { text: "", chips: [{ key: "in", value: "Untagged" }] }],
    ["an unknown in: stays text", "in:nowhere x", { text: "in:nowhere x", chips: [] }],
    ["a field with no value stays text", "from: x", { text: "from: x", chips: [] }],
    [
      "the key is case-insensitive",
      "FROM:Ada",
      { text: "", chips: [{ key: "from", value: "Ada" }] },
    ],
    [
      "a chip mid-query",
      "freeze from:ada deploy",
      { text: "freeze deploy", chips: [{ key: "from", value: "ada" }] },
    ],
    [
      "a later chip of the same key replaces the earlier",
      "from:ada from:bob",
      { text: "", chips: [{ key: "from", value: "bob" }] },
    ],
    [
      "all three",
      "in:github from:ada source:work-mail flaky",
      {
        text: "flaky",
        chips: [
          { key: "in", value: "GitHub" },
          { key: "from", value: "ada" },
          { key: "source", value: "work-mail" },
        ],
      },
    ],
    ["a word that only contains a colon", "re:freeze", { text: "re:freeze", chips: [] }],
  ])("%s", (_, q, expected) => {
    expect(parseQuery(q, tags)).toEqual(expected);
  });
});

describe("search params", () => {
  it.each<[string, string, Option.Option<Record<string, string>>]>([
    ["nothing typed", "", Option.none()],
    ["only spaces", "   ", Option.none()],
    ["words", "freeze", Option.some({ q: "freeze" })],
    ["chips only send an empty q", "from:ada", Option.some({ q: "", from: "ada" })],
    [
      "in: is tag, and Untagged is literal",
      "in:untagged x",
      Option.some({ q: "x", tag: "Untagged" }),
    ],
    [
      "every chip",
      "in:me from:ada source:personal-mail freeze",
      Option.some({ q: "freeze", tag: "Me", from: "ada", source: "personal-mail" }),
    ],
  ])("%s", (_, q, expected) => {
    expect(searchParams(parseQuery(q, tags))).toEqual(expected);
  });

  it("the query reads back with chips first", () => {
    expect(queryText(parseQuery("freeze in:me", tags))).toBe("in:Me freeze");
  });
});

describe("the search field", () => {
  it.each<[string, string, Field]>([
    ["plain text", "free", { chips: [], rest: "free" }],
    ["a field still being typed stays text", "from:ad", { chips: [], rest: "from:ad" }],
    [
      "a space closes a field into a chip",
      "from:ada ",
      { chips: [{ key: "from", value: "ada" }], rest: "" },
    ],
    [
      "a closed field mid-text is lifted",
      "freeze from:ada de",
      { chips: [{ key: "from", value: "ada" }], rest: "freeze de" },
    ],
    ["an unknown in: is not lifted", "in:nowhere ", { chips: [], rest: "in:nowhere " }],
  ])("%s", (_, q, expected) => {
    expect(fieldOf(q, tags)).toEqual(expected);
  });

  it("typing a space after a field makes a chip and keeps the rest", () => {
    const field = fieldOf("from:ada ", tags);
    const next = typed(field, "freeze in:me ", tags, false);
    expect(next).toEqual({
      chips: [
        { key: "from", value: "ada" },
        { key: "in", value: "Me" },
      ],
      rest: "freeze ",
    });
    expect(fieldOf(queryOf(next), tags)).toEqual(next);
  });

  it("leaving the field closes its last token", () => {
    expect(typed({ chips: [], rest: "x from:ada" }, "x from:ada", tags, true)).toEqual({
      chips: [{ key: "from", value: "ada" }],
      rest: "x",
    });
  });

  it("no chips and no text is the empty query", () => {
    expect(queryOf({ chips: [], rest: "" })).toBe("");
    expect(queryOf({ chips: [{ key: "from", value: "ada" }], rest: "" })).toBe("from:ada ");
  });
});
