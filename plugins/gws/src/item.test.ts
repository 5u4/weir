import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "./gws.ts";
import { toRawItem } from "./item.ts";

const ME = "robin.ellis@example.com";

const text = (
  mimeType: string,
  content: string,
  extra: Partial<MessagePart> = {},
): MessagePart => ({
  mimeType,
  filename: "",
  body: { data: Buffer.from(content).toString("base64url") },
  ...extra,
});

const mixed = (...parts: MessagePart[]): MessagePart => ({
  mimeType: "multipart/mixed",
  filename: "",
  parts,
});

const itemOf = (
  payload: MessagePart,
  from = "Ben Ortiz <ben@example.com>",
  labelIds?: string[],
) => {
  const message: Message = {
    id: "m1",
    threadId: "t1",
    internalDate: "1761000000000",
    ...(labelIds === undefined ? {} : { labelIds }),
    payload: {
      ...payload,
      headers: [{ name: "From", value: from }, ...(payload.headers ?? [])],
    },
  };
  return toRawItem(message, ME);
};

describe("body part selection", () => {
  it("skips an unnamed html part marked as an attachment", () => {
    const item = itemOf(
      mixed(
        text("text/plain", "Ship it."),
        text("text/html", "<p>report</p>", {
          headers: [{ name: "Content-Disposition", value: "attachment" }],
        }),
      ),
    );
    expect(item.body).toBe("Ship it.");
    expect(item.bodyNew).toBe("Ship it.");
  });

  it("skips an unnamed html child inside a named attachment", () => {
    const item = itemOf(
      mixed(text("text/plain", "Ship it."), {
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        parts: [text("text/html", "<p>forwarded</p>")],
      }),
    );
    expect(item.body).toBe("Ship it.");
  });
});

describe("body charset", () => {
  const latin1 = (contentType: string): MessagePart => ({
    mimeType: "text/plain",
    filename: "",
    headers: [{ name: "Content-Type", value: contentType }],
    body: { data: Buffer.from("Un café ?", "latin1").toString("base64url") },
  });

  it.each(['text/plain; charset="ISO-8859-1"', "text/plain; format=flowed; Charset=iso-8859-1"])(
    "decodes %s",
    (contentType) => {
      expect(itemOf(latin1(contentType)).body).toBe("Un café ?");
    },
  );

  it("falls back to UTF-8 for an unknown charset", () => {
    const part = text("text/plain", "Un café ?", {
      headers: [{ name: "Content-Type", value: "text/plain; charset=x-unknown" }],
    });
    expect(itemOf(part).body).toBe("Un café ?");
  });
});

describe("from header", () => {
  it.each([
    ["robin.ellis@example.com", "", "robin.ellis@example.com"],
    ["Ben Ortiz <Ben@Example.com>", "Ben Ortiz", "ben@example.com"],
    ['"Ortiz, Ben" <ben@example.com>', "Ortiz, Ben", "ben@example.com"],
    [
      '"Robin \\"R\\" Ellis" <robin.ellis@example.com>',
      'Robin "R" Ellis',
      "robin.ellis@example.com",
    ],
    ['"Ben <Ops>, Ortiz" <ben@example.com>', "Ben <Ops>, Ortiz", "ben@example.com"],
  ])("parses %s", (header, name, address) => {
    expect(itemOf(text("text/plain", "hi"), header).from).toEqual({
      name,
      address,
    });
  });
});

describe("body format", () => {
  const alternative = (plain: string, html: string): MessagePart => ({
    mimeType: "multipart/alternative",
    filename: "",
    parts: [text("text/plain", plain), text("text/html", html)],
  });

  const BULK = "Shop <deals@example.com>";

  it.each([
    [
      "a layout table",
      "CATEGORY_PROMOTIONS",
      `<table width="600"><tr><td>Your trip is booked</td></tr></table>`,
    ],
    ["a style block", "CATEGORY_UPDATES", `<style>p{color:#333}</style><p>Your trip is booked</p>`],
  ])("keeps a bulk email built with %s as its original HTML", (_, category, html) => {
    const item = itemOf(alternative("Your trip is booked", html), BULK, ["INBOX", category]);
    expect(item).toMatchObject({ format: "html", body: html });
  });

  it("drops the quoted history and signature from an HTML email's new part", () => {
    const html = `<table><tr><td>See you Friday</td></tr></table><div class="gmail_signature">Ben</div><div class="gmail_quote"><div class="gmail_attr">On Tue Ada wrote:</div>earlier plan</div>`;
    const item = itemOf(alternative("See you Friday", html), BULK, ["CATEGORY_SOCIAL"]);
    expect(item.format).toBe("html");
    expect(item.bodyNew).toContain("See you Friday");
    expect(item.bodyNew).not.toMatch(/Ben|earlier plan|gmail_/);
  });

  it.each([
    ["a personal", ["INBOX", "CATEGORY_PERSONAL"]],
    ["an uncategorized sent", ["SENT"]],
  ])("converts %s Outlook reply with a style block to markdown", (_, labels) => {
    const html = `<style>p.MsoNormal{margin:0}</style><div class="WordSection1"><p class="MsoNormal">Ship it.</p></div>`;
    const item = itemOf(alternative("Ship it.", html), undefined, labels);
    expect(item).toMatchObject({ format: "markdown", body: "Ship it." });
  });

  it("converts a bulk email with simple HTML to markdown", () => {
    const html = "<p>Ship <b>it</b>.</p><ul><li>today</li></ul>";
    const item = itemOf(alternative("Ship it.", html), BULK, ["CATEGORY_PROMOTIONS"]);
    expect(item).toMatchObject({
      format: "markdown",
      body: "Ship **it**.\n\n- today",
    });
  });

  it("keeps plain-only mail as markdown", () => {
    expect(itemOf(text("text/plain", "Ship it.")).format).toBe("markdown");
  });
});
