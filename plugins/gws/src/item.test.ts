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

describe("from verification", () => {
  const gmailBmo =
    'mx.google.com; dkim=pass header.i=@bmo.com header.s=pp2020 header.b=X; arc=pass (i=1 spf=pass spfdomain=bmo.com dkim=pass dkdomain=bmo.com dmarc=pass fromdomain=bmo.com); spf=pass (google.com: domain of advisors@bmo.com designates 67.231.150.52 as permitted sender) smtp.mailfrom="advisors@bmo.com"; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bmo.com';
  const upstream =
    "mx.microsoft.com 1; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=bmo.com;";
  const verifiedWith = (from: string, ...results: ReadonlyArray<readonly [string, string]>) =>
    itemOf(
      { ...text("text/plain", "hi"), headers: results.map(([name, value]) => ({ name, value })) },
      from,
    ).fromVerified;

  it.each([
    [
      "Gmail's DMARC pass above an upstream relay's result",
      "BrokerEdge <advisors@bmo.com>",
      [
        ["Authentication-Results", gmailBmo],
        ["authentication-results", upstream],
      ],
    ],
    [
      "a pass for the organizational domain of a subdomain sender",
      "Wealthsimple <hello@o.wealthsimple.com>",
      [
        [
          "Authentication-Results",
          'mx.google.com; dkim=pass header.i=@o.wealthsimple.com header.s=scph0422 header.b=X; spf=pass (google.com: domain of msprvs1=x@o.wealthsimple.com designates 223.165.123.229 as permitted sender) smtp.mailfrom="msprvs1=x@o.wealthsimple.com"; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=wealthsimple.com',
        ],
      ],
    ],
    [
      "a pass in another letter case",
      "GitHub <noreply@GitHub.com>",
      [
        [
          "AUTHENTICATION-RESULTS",
          "MX.Google.com; DMARC=Pass (p=QUARANTINE sp=REJECT dis=NONE) Header.From=GITHUB.com",
        ],
      ],
    ],
  ] as const)("trusts %s", (_, from, results) => {
    expect(verifiedWith(from, ...results)).toBe(true);
  });

  it.each([
    ["mail with no Authentication-Results, as Gmail-to-Gmail mail arrives", "ada@gmail.com", []],
    [
      "a pass that appears only inside a comment",
      "advisors@bmo.com",
      [
        [
          "Authentication-Results",
          "mx.google.com; arc=pass (i=1 (nested) dmarc=pass fromdomain=bmo.com); dmarc=fail (p=REJECT) header.from=bmo.com",
        ],
      ],
    ],
    [
      "a pass smuggled inside a quoted value",
      "advisors@bmo.com",
      [
        [
          "Authentication-Results",
          'mx.google.com; spf=pass smtp.mailfrom="x; dmarc=pass header.from=bmo.com"@evil.example; dmarc=fail header.from=bmo.com',
        ],
      ],
    ],
    [
      "an upstream pass when it is the first result",
      "advisors@bmo.com",
      [
        [
          "authentication-results",
          "mx.microsoft.com 1; dmarc=pass action=none header.from=bmo.com",
        ],
        ["Authentication-Results", gmailBmo],
      ],
    ],
    [
      "a look-alike authserv-id",
      "advisors@bmo.com",
      [["Authentication-Results", "mx.google.com.evil.example; dmarc=pass header.from=bmo.com"]],
    ],
    [
      "a DMARC fail",
      "news@bluebits.ca",
      [
        [
          "Authentication-Results",
          "mx.google.com; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=bluebits.ca",
        ],
      ],
    ],
    [
      "a domain without DMARC",
      "news@plain.example",
      [["Authentication-Results", "mx.google.com; spf=pass smtp.mailfrom=news@plain.example"]],
    ],
    [
      "a pass for some other domain",
      "Northwind <rachel@northwind.example>",
      [["Authentication-Results", "mx.google.com; dmarc=pass header.from=evil.example"]],
    ],
    [
      "a pass for a sibling subdomain",
      "hello@o.wealthsimple.com",
      [["Authentication-Results", "mx.google.com; dmarc=pass header.from=x.wealthsimple.com"]],
    ],
  ] as const)("does not trust %s", (_, from, results) => {
    expect(verifiedWith(from, ...results)).toBe(false);
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
