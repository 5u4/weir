import { describe, expect, it } from "vitest";
import { htmlBody, htmlBodyNew, plainBody, plainNew } from "./markdown.ts";

describe("plain text", () => {
  it("keeps line breaks and real lists", () => {
    expect(plainBody("Hi,\nPlan:\n1. one\n2. two\nThanks")).toBe(
      "Hi,\nPlan:\n\n1. one\n2. two\n\nThanks",
    );
  });

  it("fences a pasted diff hunk", () => {
    expect(plainBody("See:\n-    a\n-    b\n+    c")).toBe(
      "See:\n\n```diff\n-    a\n-    b\n+    c\n```",
    );
  });

  it("cuts bodyNew at the signature delimiter", () => {
    expect(plainNew("Ship it.\n\n-- \nRobin Ellis\nLedgerline")).toBe("Ship it.");
  });

  it("cuts bodyNew at an attribution followed by quoted lines", () => {
    expect(
      plainNew(
        "Sounds good.\n\nOn Mon, Oct 20, 2026 at 9:00 AM Ben <b@example.com> wrote:\n> plan?",
      ),
    ).toBe("Sounds good.");
  });

  it("keeps an attribution-looking line that quotes nothing", () => {
    expect(plainNew("On Monday the team wrote:\nthe plan")).toBe(
      "On Monday the team wrote:\nthe plan",
    );
  });
});

describe("html", () => {
  const html =
    '<div dir="ltr"><p>Use **bold** at <a href="https://x.example/a">https://x.example/a</a><br>next line</p></div>' +
    '<div class="gmail_signature">Robin</div>' +
    '<div class="gmail_quote"><div class="gmail_attr">On Mon Ben wrote:</div><blockquote class="gmail_quote">old</blockquote></div>';

  it("shows the sender's typed asterisks as text in bodyNew and drops signature and quote", () => {
    expect(htmlBodyNew(html)).toBe("Use \\*\\*bold\\*\\* at <https://x.example/a>\\\nnext line");
  });

  it("keeps signature and quote in body", () => {
    const body = htmlBody(html);
    expect(body).toContain("Robin");
    expect(body).toContain("> old");
  });

  it("drops a standalone quote blockquote and signature paragraph from bodyNew", () => {
    expect(
      htmlBodyNew(
        '<p>Ship it.</p><p class="gmail_signature">Robin</p><blockquote class="gmail_quote">old</blockquote>',
      ),
    ).toBe("Ship it.");
  });
});
