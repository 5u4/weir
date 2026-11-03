import { describe, expect, it } from "vitest";
import { derive } from "./Body.ts";

const newPart = (body: string) => derive({ format: "markdown", body, bodyNew: null }).bodyNew;

describe("markdown without a separated new part", () => {
  it("drops quoted lines", () => {
    expect(newPart("Agreed.\n> earlier point\n>> older point\nSee you then.")).toBe(
      "Agreed.\nSee you then.",
    );
  });

  it("drops everything from an On … wrote: line onward", () => {
    expect(
      newPart(
        "Ship it.\r\n\r\nOn Tue, Oct 27, 2026 at 9:00 AM Ada <ada@example.com> wrote:\r\nunquoted history",
      ),
    ).toBe("Ship it.");
  });

  it("recognises an attribution wrapped onto a second line", () => {
    expect(
      newPart(
        "Ship it.\n\nOn Tue, Oct 27, 2026 at 9:00 AM Ada Lovelace <\nada@example.com> wrote:\n> plan",
      ),
    ).toBe("Ship it.");
  });

  const threeLineAttribution =
    "On Tue, Oct 27, 2026 at 9:00 AM\nAda Lovelace\n<ada@example.com> wrote:";

  it("recognises an attribution wrapped over three lines before quoted history", () => {
    expect(newPart(`Ship it.\n\n${threeLineAttribution}\n> plan\n>> older plan`)).toBe("Ship it.");
  });

  it("recognises an attribution wrapped over three lines before unquoted history", () => {
    expect(newPart(`Ship it.\n\n${threeLineAttribution}\nunquoted history`)).toBe("Ship it.");
  });

  it("keeps a paragraph that starts with On and never reaches wrote:", () => {
    const body = "On Monday we shipped the fix.\nIt went fine.\nThanks";
    expect(newPart(body)).toBe(body);
  });

  it("does not treat a five-line block ending in wrote: as an attribution", () => {
    const body =
      "Ship it.\n\nOn Tue, Oct 27, 2026\nat 9:00 AM\nAda\nLovelace\n<ada@example.com> wrote:";
    expect(newPart(body)).toBe(body);
  });

  it("keeps a sentence that merely starts with On", () => {
    expect(newPart("On Monday we deploy.\nThanks")).toBe("On Monday we deploy.\nThanks");
  });

  it("drops the signature from the -- delimiter line onward", () => {
    expect(newPart("Ship it.\n\n-- \nAda Lovelace\nStaff Engineer")).toBe("Ship it.");
    expect(newPart("Ship it.\r\n--\r\nAda")).toBe("Ship it.");
  });

  it("keeps double dashes inside a line", () => {
    expect(newPart("Run it with --force -- then tell me.")).toBe(
      "Run it with --force -- then tell me.",
    );
  });
});

describe("visible text", () => {
  it("is what the reader sees of markdown, without markup or URLs", () => {
    expect(
      derive({ format: "markdown", body: "**ship** [it](https://x.example)", bodyNew: null }).text,
    ).toBe("ship it");
  });

  it("drops loaded image alts and link targets but keeps the alt of a blocked image", () => {
    const { text } = derive({
      format: "markdown",
      body: "[![](https://cdn.example/b.png)](https://news.example/i)\n\n# Hi\n\n![Chart](https://cdn.example/c.png)\n\n![Old chart](http://cdn.example/o.png)\n\nSee [the primer](https://news.example/primer) and `run()`.",
      bodyNew: null,
    });
    expect(text).toBe("Hi\n\nOld chart\n\nSee the primer and run().");
  });

  it("reads raw HTML inside markdown as HTML, not as tags", () => {
    const { text } = derive({
      format: "markdown",
      body: "Hello <b>there</b>\n\n<div><p>See the <i>spec</i></p></div>",
      bodyNew: null,
    });
    expect(text).toBe("Hello there\n\nSee the spec");
  });

  it("covers the whole message while the new text stops at the quoted history", () => {
    const derived = derive({
      format: "markdown",
      body: "Ship it.\n\nOn Tue, Oct 27, 2026 at 9:00 AM Ada <ada@example.com> wrote:\n> the plan",
      bodyNew: null,
    });
    expect(derived.textNew).toBe("Ship it.");
    expect(derived.text).toContain("the plan");
  });

  it("is the rendered text of an HTML email, never its head, CSS, comments or tag names", () => {
    const html = `<!doctype html><html><head><title>Receipt title</title><style>.hero{color:#600;width:600px}</style></head><body><!-- tracking --><table width="600" class="hero"><tr><td>Flight</td><td>YVR</td></tr><tr><td>Seat</td><td>14A</td></tr></table><p style="font-size:60px">Bon voyage</p></body></html>`;
    const { text, textNew, bodyNew } = derive({ format: "html", body: html, bodyNew: html });
    expect(bodyNew).toBe(html);
    expect(textNew).toBe(text);
    expect(text).toBe("Flight YVR\nSeat 14A\n\nBon voyage");
  });

  it("keeps the new part separate from the whole HTML message", () => {
    const derived = derive({
      format: "html",
      body: "<p>Thanks</p><blockquote>older thread</blockquote>",
      bodyNew: "<p>Thanks</p>",
    });
    expect(derived.textNew).toBe("Thanks");
    expect(derived.text).toBe("Thanks\n\nolder thread");
  });

  it("drops the invisible filler preheaders pad with and reads no-break spaces as spaces", () => {
    const { text } = derive({
      format: "html",
      body: "<div>Your trip\u00a0is booked\u200c\u034f \u200c\u034f\u00ad\u200b\u2060\ufeff</div><div>Lisbon</div>",
      bodyNew: "",
    });
    expect(text).toBe("Your trip is booked\nLisbon");
  });
});
