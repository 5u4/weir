import { describe, expect, it } from "vitest";
import { stripQuoted } from "./Body.ts";

describe("stripQuoted", () => {
  it("drops quoted lines", () => {
    expect(stripQuoted("Agreed.\n> earlier point\n>> older point\nSee you then.")).toBe(
      "Agreed.\nSee you then.",
    );
  });

  it("drops everything from an On … wrote: line onward", () => {
    expect(
      stripQuoted(
        "Ship it.\r\n\r\nOn Tue, Oct 27, 2026 at 9:00 AM Ada <ada@example.com> wrote:\r\nunquoted history",
      ),
    ).toBe("Ship it.");
  });

  it("recognises an attribution wrapped onto a second line", () => {
    expect(
      stripQuoted(
        "Ship it.\n\nOn Tue, Oct 27, 2026 at 9:00 AM Ada Lovelace <\nada@example.com> wrote:\n> plan",
      ),
    ).toBe("Ship it.");
  });

  it("keeps a sentence that merely starts with On", () => {
    expect(stripQuoted("On Monday we deploy.\nThanks")).toBe("On Monday we deploy.\nThanks");
  });
});
