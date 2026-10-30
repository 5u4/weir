import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type * as Mdast from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype, { type Options } from "remark-rehype";
import { unified } from "unified";

export type { Root } from "hast";

type Handlers = NonNullable<Options["handlers"]>;
type State = Parameters<NonNullable<Handlers["text"]>>[0];

const longUrl = 56;
const cacheLimit = 500;
const trees = new Map<string, Root>();

const text = (value: string): Text => ({ type: "text", value });

const element = (
  tagName: string,
  children: Array<ElementContent>,
  properties: Element["properties"] = {},
): Element => ({ type: "element", tagName, properties, children });

const blockParents: Record<string, true> = {
  root: true,
  blockquote: true,
  listItem: true,
  footnoteDefinition: true,
};

const link = (state: State, url: string | undefined, node: Mdast.Link | Mdast.LinkReference) => {
  const children = state.all(node);
  return url === undefined ? children : element("a", children, { dataUrl: url });
};

const handlers: Handlers = {
  text: (_, node: Mdast.Text) => text(node.value),
  inlineCode: (_, node: Mdast.InlineCode) => element("code", [text(node.value)]),
  break: () => element("br", []),
  code: (_, node: Mdast.Code) =>
    node.value === "" ? undefined : element("pre", [element("code", [text(node.value)])]),
  html: (_, node: Mdast.Html, parent) =>
    parent !== undefined && blockParents[parent.type] === true
      ? element("p", [text(node.value)], { className: ["b-html"] })
      : text(node.value),
  image: (_, node: Mdast.Image | Mdast.ImageReference) => {
    const alt = node.alt?.trim() ?? "";
    return alt === "" ? undefined : element("span", [text(alt)], { className: ["b-img"] });
  },
  imageReference: (state, node: Mdast.ImageReference, parent) =>
    handlers.image?.(state, node, parent),
  link: (state, node: Mdast.Link) => link(state, node.url, node),
  linkReference: (state, node: Mdast.LinkReference) =>
    link(state, state.definitionById.get(node.identifier.toUpperCase())?.url, node),
  footnoteReference: (_, node: Mdast.FootnoteReference) =>
    text(`[${node.label ?? node.identifier}]`),
  footnoteDefinition: (state, node: Mdast.FootnoteDefinition) => state.all(node),
  list: (state, node: Mdast.List) =>
    element(
      node.ordered === true ? "ol" : "ul",
      state.all(node),
      node.ordered === true && typeof node.start === "number" && node.start !== 1
        ? { start: node.start }
        : {},
    ),
  listItem: (state, node: Mdast.ListItem) =>
    element(
      "li",
      state.all(node),
      typeof node.checked === "boolean" ? { dataTask: node.checked ? "[x] " : "[ ] " } : {},
    ),
  table: (state, node: Mdast.Table) => {
    const row = (cells: Mdast.TableRow, cell: "th" | "td") =>
      element(
        "tr",
        cells.children.map((content) => element(cell, state.all(content))),
      );
    const [head, ...rows] = node.children;
    return element("table", [
      ...(head === undefined ? [] : [element("thead", [row(head, "th")])]),
      element(
        "tbody",
        rows.map((cells) => row(cells, "td")),
      ),
    ]);
  },
};

const textOf = (node: ElementContent | RootContent): string =>
  node.type === "text"
    ? node.value
    : node.type === "element"
      ? node.children.map(textOf).join("")
      : "";

const blank = (node: Element) => textOf(node).trim() === "";

const safeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
};

const shortUrl = (url: URL) =>
  url.pathname.length > 24 || url.search !== "" || url.hash !== ""
    ? `${url.host}${url.pathname.slice(0, 24)}…`
    : `${url.host}${url.pathname}`;

const containers: Record<string, true> = {
  blockquote: true,
  ul: true,
  ol: true,
  li: true,
  table: true,
  thead: true,
  tbody: true,
  tr: true,
};
const prunedWhenEmpty: Record<string, true> = {
  blockquote: true,
  ul: true,
  ol: true,
  li: true,
  strong: true,
  em: true,
  del: true,
};
const headings: Record<string, true> = {
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
};

const merge = (nodes: Array<ElementContent>, inContainer: boolean): Array<ElementContent> =>
  nodes.reduce<Array<ElementContent>>((merged, node) => {
    if (node.type === "text") {
      if (node.value === "" || (inContainer && node.value.trim() === "")) return merged;
      const last = merged.at(-1);
      if (last?.type === "text") {
        merged[merged.length - 1] = text(last.value + node.value);
        return merged;
      }
    }
    merged.push(node);
    return merged;
  }, []);

const anchor = (node: Element, url: string): Array<ElementContent> => {
  const safe = safeUrl(url);
  if (blank(node) || safe === null) return node.children;
  const [only] = node.children;
  const shortened =
    node.children.length === 1 &&
    only?.type === "text" &&
    only.value === url &&
    url.length > longUrl &&
    safe.protocol !== "mailto:";
  return [
    shortened
      ? element("a", [text(shortUrl(safe))], {
          href: safe.href,
          target: "_blank",
          rel: ["noreferrer", "noopener"],
          title: url,
          className: ["url"],
        })
      : element("a", node.children, {
          href: safe.href,
          target: "_blank",
          rel: ["noreferrer", "noopener"],
        }),
  ];
};

const clean = (node: ElementContent): Array<ElementContent> => {
  if (node.type !== "element") return [node];
  const children = merge(node.children.flatMap(clean), containers[node.tagName] === true);
  const { dataUrl, dataTask, ...properties } = node.properties;
  const tagName = headings[node.tagName]
    ? `h${Math.min(Number(node.tagName.slice(1)) + 2, 6)}`
    : node.tagName;
  const next: Element = { ...node, tagName, properties, children };
  if (typeof dataUrl === "string") return anchor(next, dataUrl);
  if (typeof dataTask === "string") {
    const [first, ...rest] = children;
    next.children =
      first?.type === "element" && first.tagName === "p"
        ? [{ ...first, children: [text(dataTask), ...first.children] }, ...rest]
        : [element("p", [text(dataTask)]), ...children];
  }
  if ((node.tagName === "p" || headings[node.tagName]) && blank(next)) return [];
  if (prunedWhenEmpty[node.tagName] && next.children.length === 0) return [];
  return [next];
};

const rehypeWeir = () => (tree: Root) => {
  const children = merge(
    tree.children.flatMap((child) => (child.type === "doctype" ? [] : clean(child))),
    true,
  );
  tree.children = children;
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { handlers })
  .use(rehypeWeir)
  .freeze();

export const hast = (markdown: string): Root => {
  const cached = trees.get(markdown);
  if (cached !== undefined) return cached;
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  const oldest = trees.keys().next();
  if (trees.size >= cacheLimit && oldest.done !== true) trees.delete(oldest.value);
  trees.set(markdown, tree);
  return tree;
};

const textLeaves = (node: RootContent): ReadonlyArray<string> =>
  node.type === "text"
    ? [node.value]
    : node.type === "element"
      ? node.children.flatMap(textLeaves)
      : [];

export const leaves = (tree: Root): ReadonlyArray<string> => tree.children.flatMap(textLeaves);

export const plainText = (markdown: string) => leaves(hast(markdown)).join(" ");
