import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Email, emailDocument } from "./Email.tsx";

const email = `<html><head><meta http-equiv="Content-Security-Policy" content="img-src *"><style>body{color:red}</style></head><body><table><tr><td>Lisbon</td></tr></table></body></html>`;

const attribute = (markup: string, name: string) =>
  markup
    .match(new RegExp(` ${name}="([^"]*)"`))?.[1]
    ?.replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

describe("Email", () => {
  const markup = renderToStaticMarkup(<Email html={email} title="Your trip" />);

  it("frames the email in a sandbox that runs no scripts and opens links outside", () => {
    expect(attribute(markup, "sandbox")).toBe(
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    expect(markup).not.toContain("allow-scripts");
    expect(attribute(markup, "referrerPolicy")).toBe("no-referrer");
    expect(attribute(markup, "title")).toBe("Your trip");
    expect(attribute(markup, "srcDoc")).toBe(emailDocument(email));
  });

  it("opens the head with weir's policy so it applies before any of the email's markup", () => {
    const page = emailDocument(email);
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toMatch(/^<!doctype html><html><head><meta charset="utf-8">/);
    expect(head).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:">`,
    );
    expect(page.indexOf("default-src 'none'")).toBeLessThan(page.indexOf("img-src *"));
    expect(page.endsWith(email)).toBe(true);
  });

  it("asks for a light page, no referrer, and new tabs for links", () => {
    const page = emailDocument("<p>Hi</p>");
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toContain('<meta name="color-scheme" content="light">');
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    expect(head).toContain('<base target="_blank">');
  });
});
