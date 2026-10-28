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

  const threeLineAttribution =
    "On Tue, Oct 27, 2026 at 9:00 AM\nAda Lovelace\n<ada@example.com> wrote:";

  it("recognises an attribution wrapped over three lines before quoted history", () => {
    expect(stripQuoted(`Ship it.\n\n${threeLineAttribution}\n> plan\n>> older plan`)).toBe(
      "Ship it.",
    );
  });

  it("recognises an attribution wrapped over three lines before unquoted history", () => {
    expect(stripQuoted(`Ship it.\n\n${threeLineAttribution}\nunquoted history`)).toBe("Ship it.");
  });

  it("keeps a paragraph that starts with On and never reaches wrote:", () => {
    const body = "On Monday we shipped the fix.\nIt went fine.\nThanks";
    expect(stripQuoted(body)).toBe(body);
  });

  it("does not treat a five-line block ending in wrote: as an attribution", () => {
    const body =
      "Ship it.\n\nOn Tue, Oct 27, 2026\nat 9:00 AM\nAda\nLovelace\n<ada@example.com> wrote:";
    expect(stripQuoted(body)).toBe(body);
  });

  it("keeps a sentence that merely starts with On", () => {
    expect(stripQuoted("On Monday we deploy.\nThanks")).toBe("On Monday we deploy.\nThanks");
  });

  it("drops the signature from the -- delimiter line onward", () => {
    expect(stripQuoted("Ship it.\n\n-- \nAda Lovelace\nStaff Engineer")).toBe("Ship it.");
    expect(stripQuoted("Ship it.\r\n--\r\nAda")).toBe("Ship it.");
  });

  it("keeps double dashes inside a line", () => {
    expect(stripQuoted("Run it with --force -- then tell me.")).toBe(
      "Run it with --force -- then tell me.",
    );
  });
});
