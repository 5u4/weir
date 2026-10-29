import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "./gws.ts";
import { toRawItem } from "./item.ts";

const text = (mimeType: string, content: string): MessagePart => ({
  mimeType,
  filename: "",
  body: { data: Buffer.from(content).toString("base64url") },
});

const itemOf = (payload: MessagePart) => {
  const message: Message = {
    id: "m1",
    threadId: "t1",
    internalDate: "1761000000000",
    payload: { ...payload, headers: [{ name: "From", value: "Ben Ortiz <ben@example.com>" }] },
  };
  return toRawItem(message, "robin.ellis@example.com");
};

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
      "<p>&#xE000;one&#xE001; &#57346;two&#57347 &#X0e000;three&#xe001; &#xE004;four&#57349;</p>",
      "\uFFFDone\uFFFD \uFFFDtwo\uFFFD \uFFFDthree\uFFFD \uFFFDfour\uFFFD",
    ],
    [
      "literal characters",
      "<p>\uE000one\uE001 \uE002two\uE003 \uE004three\uE005</p>",
      "\uFFFDone\uFFFD \uFFFDtwo\uFFFD \uFFFDthree\uFFFD",
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
    ["neighbouring code points", "<p>&#xE0001;&#xE006;&#57350;</p>", "\u{E0001}\uE006\uE006"],
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

type Tag = "b" | "strong" | "i" | "em";

type Inline =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "span"; readonly tag: Tag; readonly children: readonly Inline[] }
  | { readonly kind: "img" }
  | { readonly kind: "link"; readonly children: readonly Inline[] };

type Case = { readonly quoted: boolean; readonly content: readonly Inline[] };

type Styled = { readonly char: string; readonly strong: boolean; readonly em: boolean };

const IMG = '<img src="https://cdn.example/i(1).png" alt="Logo">';
const HREF = "https://example.com/p";
const invisible = /[\s\u200B\u200C\u2060\uFEFF]/u;
const wordChar = /[\p{L}\p{N}]/u;
const isStrong = (tag: Tag) => tag === "b" || tag === "strong";

const htmlOf = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return node.value;
        case "img":
          return IMG;
        case "span":
          return `<${node.tag}>${htmlOf(node.children)}</${node.tag}>`;
      }
      return `<a href="${HREF}">${htmlOf(node.children)}</a>`;
    })
    .join("");

const caseHtml = ({ quoted, content }: Case) => {
  const paragraph = `<p>${htmlOf(content)}</p>`;
  return quoted ? `<blockquote>${paragraph}</blockquote>` : paragraph;
};

const visible = (chars: readonly Styled[]) => chars.filter(({ char }) => !invisible.test(char));

const expectedOf = (nodes: readonly Inline[], strong = false, em = false): Styled[] =>
  nodes.flatMap((node) => {
    switch (node.kind) {
      case "text":
        return [...node.value].map((char) => ({ char, strong, em }));
      case "img":
        return [];
      case "span":
        return expectedOf(node.children, strong || isStrong(node.tag), em || !isStrong(node.tag));
    }
    return expectedOf(node.children, strong, em);
  });

const actualOf = (node: Nodes, strong = false, em = false): Styled[] => {
  if (node.type === "text") return [...node.value].map((char) => ({ char, strong, em }));
  if (!("children" in node)) return [];
  const nextStrong = strong || node.type === "strong";
  const nextEm = em || node.type === "emphasis";
  return node.children.flatMap((child) => actualOf(child, nextStrong, nextEm));
};

const mismatch = (expected: readonly Styled[], actual: readonly Styled[]) => {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const want = expected[index];
    const got = actual[index];
    if (want?.char !== got?.char) return { index, reason: "characters differ", want, got };
    if (want && got && wordChar.test(want.char)) {
      if (want.strong !== got.strong || want.em !== got.em) {
        return { index, reason: "emphasis differs", want, got };
      }
    }
  }
  return null;
};

const describeStyled = (styled: Styled | undefined) =>
  styled
    ? `${JSON.stringify(styled.char)}${styled.strong ? " strong" : ""}${styled.em ? " em" : ""}`
    : "end";

const checkTree = (html: string, expectedChars: readonly Styled[]): string[] => {
  const expected = visible(expectedChars);
  const item = itemOf(text("text/html", html));
  const fields = [
    ["body", item.body],
    ["bodyNew", item.bodyNew ?? ""],
  ] as const;
  return fields.flatMap(([field, markdown]) => {
    const actual = visible(actualOf(fromMarkdown(markdown)));
    const found = mismatch(expected, actual);
    if (!found) return [];
    const context = expected
      .slice(Math.max(0, found.index - 8), found.index + 8)
      .map(({ char }) => char)
      .join("");
    return [
      `${field}: ${found.reason} at visible index ${found.index} (near ${JSON.stringify(context)}): want ${describeStyled(found.want)}, got ${describeStyled(found.got)}\n  html: ${html}\n  markdown: ${JSON.stringify(markdown)}`,
    ];
  });
};

const parseHtmlTree = (html: string): Inline[] => {
  const root: Inline[] = [];
  const stack: { tag: Tag | "a"; children: Inline[] }[] = [];
  const top = () => stack.at(-1)?.children ?? root;
  for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
    const open = /^<(b|strong|i|em|a)\b[^>]*>$/.exec(token);
    const close = /^<\/(b|strong|i|em|a)>$/.exec(token);
    if (open) stack.push({ tag: open[1] as Tag | "a", children: [] });
    else if (close) {
      const frame = stack.pop();
      if (!frame) throw new Error(`unbalanced ${html}`);
      top().push(
        frame.tag === "a"
          ? { kind: "link", children: frame.children }
          : { kind: "span", tag: frame.tag, children: frame.children },
      );
    } else if (token.startsWith("<img")) top().push({ kind: "img" });
    else if (!token.startsWith("<")) top().push({ kind: "text", value: token });
  }
  return root;
};

const check = (html: string) => checkTree(html, expectedOf(parseHtmlTree(html)));

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const generator = (seed: number) => {
  const random = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const word = () => Array.from({ length: int(1, 6) }, () => pick([...letters])).join("");
  const token = () => {
    const roll = random();
    if (roll < 0.45) return word();
    if (roll < 0.6) return " ";
    if (roll < 0.82) return pick(["!", "?", ".", ",", "-", "(", ")", "'", '"', ":", ";"]);
    if (roll < 0.94) return pick(["*", "**", "_", "__"]);
    return pick(["\u200B", "\u200C"]);
  };
  const textNode = (): Inline => ({
    kind: "text",
    value: Array.from({ length: int(1, 5) }, token).join(""),
  });
  const tag = () => pick<Tag>(["b", "strong", "i", "em"]);
  const span = (depth: number, inLink: boolean, spanTag = tag()): Inline => ({
    kind: "span",
    tag: spanTag,
    children: inlines(int(0, 3), depth + 1, inLink),
  });
  const inline = (depth: number, inLink: boolean): Inline[] => {
    if (depth >= 4) return [textNode()];
    const roll = random();
    if (roll < 0.3) return [textNode()];
    if (roll < 0.62) return [span(depth, inLink)];
    if (roll < 0.74) {
      const first = tag();
      const second = random() < 0.5 ? first : tag();
      return [span(depth, inLink, first), span(depth, inLink, second)];
    }
    if (roll < 0.87) {
      if (inLink) return [span(depth, inLink)];
      return [{ kind: "link", children: inlines(int(1, 3), depth + 1, true) }];
    }
    return inLink ? [textNode()] : [{ kind: "img" }];
  };
  const inlines = (count: number, depth: number, inLink: boolean): Inline[] =>
    Array.from({ length: count }, () => inline(depth, inLink)).flat();
  return (): Case => ({
    quoted: random() < 0.2,
    content: [{ kind: "text", value: "Start " }, ...inlines(int(1, 6), 1, false)],
  });
};

const family = (node: Inline) =>
  node.kind === "span" ? (isStrong(node.tag) ? "strong" : "em") : null;

const visibleText = (nodes: readonly Inline[]) =>
  visible(expectedOf(nodes))
    .map(({ char }) => char)
    .join("");

const featuresOf = (nodes: readonly Inline[]) => {
  const tags = new Set<string>();
  const visit = (siblings: readonly Inline[], families: ReadonlySet<string>) => {
    siblings.forEach((node, index) => {
      const next = siblings[index + 1];
      if (node.kind === "text" && /[*_]/.test(node.value)) tags.add("star-or-underscore-in-text");
      if (next && family(node) && family(next)) {
        tags.add(family(node) === family(next) ? "adjacent-same-kind" : "adjacent-mixed-kinds");
      }
      if (
        next &&
        ((node.kind === "link" && family(next)) || (family(node) && next.kind === "link"))
      ) {
        tags.add("link-edge");
      }
      if (
        next &&
        ((node.kind === "img" && family(next)) || (family(node) && next.kind === "img"))
      ) {
        tags.add("image-edge");
      }
      if (node.kind === "span" || node.kind === "link") {
        const first = node.children[0];
        const last = node.children.at(-1);
        const edges = [first, last];
        if (node.kind === "span") {
          if (edges.some((edge) => edge?.kind === "link")) tags.add("link-edge");
          if (edges.some((edge) => edge?.kind === "img")) tags.add("image-edge");
          const content = visibleText(node.children);
          if (content === "") tags.add("empty-span");
          else if (!wordChar.test(content[0] ?? "") || !wordChar.test(content.at(-1) ?? "")) {
            tags.add("punctuation-at-span-edge");
          }
          const own = family(node) ?? "";
          if (families.has(own)) tags.add("nested-same-kind");
          visit(node.children, new Set([...families, own]));
        } else {
          if (edges.some((edge) => family(edge ?? { kind: "img" }))) tags.add("link-edge");
          visit(node.children, families);
        }
      }
    });
  };
  visit(nodes, new Set());
  return [...tags];
};

describe("emphasis oracle", () => {
  it.each([
    "<p><i>*</i></p>",
    "<p><i>a*b</i></p>",
    "<p><i>x<b>A</b></i><i><b>B</b>y</i></p>",
    "<p><b>Go</b><i>-fast</i></p>",
    "<p><b>Hello!</b><i>world</i></p>",
  ])("renders %s with the same text and emphasis", (html) => {
    expect(check(html).join("\n")).toBe("");
    const item = itemOf(text("text/html", html));
    for (const markdown of [item.body, item.bodyNew ?? ""]) {
      expect(markdown.split("\n").filter((line) => line.trim() === "***")).toEqual([]);
    }
  });

  it("renders 3000 generated emphasis shapes with the same text and emphasis", () => {
    const next = generator(0x5eed_2026);
    const failures: string[] = [];
    const failedByTag = new Map<string, number>();
    const seenByTag = new Map<string, number>();
    for (let index = 0; index < 3000; index++) {
      const generated = next();
      const html = caseHtml(generated);
      const problems = checkTree(html, expectedOf(generated.content));
      const tags = featuresOf(generated.content);
      for (const tag of tags) seenByTag.set(tag, (seenByTag.get(tag) ?? 0) + 1);
      if (problems.length === 0) continue;
      for (const tag of tags) failedByTag.set(tag, (failedByTag.get(tag) ?? 0) + 1);
      failures.push(`case ${index} [${tags.join(", ")}]\n${problems.join("\n")}`);
    }
    const counts = [...failedByTag]
      .sort(([, a], [, b]) => b - a)
      .map(([tag, count]) => `${tag}: ${count}/${seenByTag.get(tag)}`)
      .join(", ");
    expect(
      failures.length,
      `${failures.length} of 3000 failed, ${failures.filter((failure) => !failure.includes("star-or-underscore-in-text")).length} without * or _ in text (by shape, failed/seen: ${counts})\n\n${failures.slice(0, 20).join("\n\n")}`,
    ).toBe(0);
  });
});
