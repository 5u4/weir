import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
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

const itemOf = (payload: MessagePart, from = "Ben Ortiz <ben@example.com>") => {
  const message: Message = {
    id: "m1",
    threadId: "t1",
    internalDate: "1761000000000",
    payload: { ...payload, headers: [{ name: "From", value: from }, ...(payload.headers ?? [])] },
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

const rendered = (markdown: string) => {
  const text: string[] = [];
  const emphasized = new Set<string>();
  const textOf = (node: Nodes): string =>
    node.type === "text"
      ? node.value
      : "children" in node
        ? node.children.map(textOf).join("")
        : "";
  const walk = (node: Nodes) => {
    if (node.type === "text") text.push(node.value);
    if (node.type === "strong" || node.type === "emphasis") emphasized.add(textOf(node));
    if ("children" in node) node.children.forEach(walk);
  };
  walk(fromMarkdown(markdown));
  return { text: text.join(" "), emphasized: [...emphasized] };
};

describe("html emphasis", () => {
  it.each([
    ["an empty bold", "<p>a<b></b> b</p>", [], ["a", "b"]],
    ["zero-width bold", "<p><b>&zwnj;</b><b>&#8203;</b>after</p>", [], ["after"]],
    ["whitespace inside the tags", "<p><b> Foo </b>bar</p>", ["Foo"], ["bar"]],
    ["line breaks inside the tags", "<p><b><br>Foo<br></b>bar</p>", ["Foo"], ["bar"]],
    ["nested bold", "<p><b><b>Foo</b></b> bar</p>", ["Foo"], ["bar"]],
    ["adjacent bold", "<p><b>Up</b><b>date</b> now</p>", ["Update"], ["now"]],
    [
      "adjacent bold in a quote",
      "<blockquote><b>Quo</b><b>ted</b> here</blockquote>",
      ["Quoted"],
      ["here"],
    ],
    [
      "a bold image",
      '<p><b><img src="https://cdn.example/a.png" alt="Logo"></b>next</p>',
      [],
      ["next"],
    ],
    ["bold paragraphs", "<b><p>One</p><p>Two</p></b>", [], ["One", "Two"]],
    ["a bold paragraph", "<b><p>Title</p></b><p>body</p>", ["Title"], ["body"]],
    ["adjacent italics", "<p><i>re</i><i>ad</i> me</p>", ["read"], ["me"]],
    ["an italic line break", "<p><i><br>It</i> x</p>", ["It"], ["x"]],
    [
      "a bold image with parentheses in its URL",
      '<p><b><img src="https://cdn.example/a(1).png" alt="Logo"></b>next</p>',
      [],
      ["next"],
    ],
    [
      "bold wrapping italic and trailing text",
      "<p><b><i>Ship it today</i>x!</b> next</p>",
      ["Ship it todayx!", "Ship it today"],
      ["next"],
    ],
    [
      "bold italic right after a word",
      "<p>Note<b><i>Read me (twice please)</i></b> after</p>",
      ["Read me (twice please)"],
      ["Note", "after"],
    ],
    [
      "bold italic opening with punctuation after a word",
      "<p>Go<b><i>-fast and far</i></b> end</p>",
      ["fast and far"],
      ["Go-", "end"],
    ],
    [
      "bold italic opening with punctuation in a quote",
      "<blockquote>Go<b><i>-fast and far</i></b> end</blockquote>",
      ["fast and far"],
      ["Go-", "end"],
    ],
  ])("renders %s without stray delimiters", (_, html, emphasized, words) => {
    const item = itemOf(text("text/html", html));
    for (const markdown of [item.body, item.bodyNew ?? ""]) {
      const view = rendered(markdown);
      expect(view.text).not.toMatch(/[*_]/);
      expect(view.emphasized).toEqual(emphasized);
      for (const word of words) expect(view.text).toContain(word);
    }
  });

  it.each([
    ["a heading", "<b><h1>Title</h1></b>", "heading"],
    ["a list", "<b><ul><li>One</li><li>Two</li></ul></b>", "list"],
    ["a quote", "<b><blockquote>Quoted</blockquote></b>", "blockquote"],
  ] as const)("keeps %s inside bold as a block", (_, html, type) => {
    const item = itemOf(text("text/html", html));
    for (const markdown of [item.body, item.bodyNew ?? ""]) {
      expect(fromMarkdown(markdown).children.map((node) => node.type)).toEqual([type]);
      expect(rendered(markdown).text).not.toMatch(/[*_]/);
    }
  });

  it.each([
    [
      "numeric references",
      "<p>&#xE000;one&#xE001; &#57346;two&#57347 &#X0e000;three&#xe001;</p>",
      "\uFFFDone\uFFFD \uFFFDtwo\uFFFD \uFFFDthree\uFFFD",
    ],
    [
      "literal characters",
      "<p>\uE000one\uE001 \uE002two\uE003</p>",
      "\uFFFDone\uFFFD \uFFFDtwo\uFFFD",
    ],
    [
      "references rebuilt around a removed one",
      "<p>&#&#xE000;xE000;one&#&#xE001;xE001;</p>",
      "&#\uFFFDxE000;one&#\uFFFDxE001;",
    ],
    [
      "an image alt",
      '<p><img alt="&#xE002;Logo&#xE003;" src="https://cdn.example/a.png"> next</p>',
      "![\uFFFDLogo\uFFFD](https://cdn.example/a.png) next",
    ],
    ["neighbouring code points", "<p>&#xE0001;&#xE004;&#57348;</p>", "\u{E0001}\uE004\uE004"],
  ])("replaces emphasis sentinel code points in %s", (_, html, body) => {
    expect(itemOf(text("text/html", html)).body).toBe(body);
  });

  it("converts bold around a long zero-width run in linear time", () => {
    const html = `<p><b>a${"\u200c".repeat(100_000)}b</b> c</p>`;
    const started = performance.now();
    itemOf(text("text/html", html));
    expect(performance.now() - started).toBeLessThan(500);
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
    expect(itemOf(text("text/plain", "hi"), header).from).toEqual({ name, address });
  });
});
