import type * as Mdast from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export type Inline =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Strong" | "Emphasis" | "Delete"; readonly children: ReadonlyArray<Inline> }
  | { readonly _tag: "InlineCode"; readonly text: string }
  | {
      readonly _tag: "Link";
      readonly href: string | null;
      readonly title: string | null;
      readonly children: ReadonlyArray<Inline>;
    }
  | { readonly _tag: "ImageAlt"; readonly alt: string }
  | { readonly _tag: "Break" };

export type Block =
  | { readonly _tag: "Paragraph"; readonly children: ReadonlyArray<Inline> }
  | {
      readonly _tag: "Heading";
      readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: ReadonlyArray<Inline>;
    }
  | {
      readonly _tag: "List";
      readonly ordered: boolean;
      readonly start: number | null;
      readonly items: ReadonlyArray<ReadonlyArray<Block>>;
    }
  | { readonly _tag: "Quote"; readonly children: ReadonlyArray<Block> }
  | { readonly _tag: "Code"; readonly text: string }
  | { readonly _tag: "Rule" }
  | { readonly _tag: "Table"; readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>> }
  | { readonly _tag: "Html"; readonly text: string };

export type Visible = ReadonlyArray<Block>;

const options = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

const longUrl = 56;

const cacheLimit = 500;
const trees = new Map<string, Visible>();

type Definitions = ReadonlyMap<string, string>;

const inlineLeaves = (node: Inline): ReadonlyArray<string> => {
  switch (node._tag) {
    case "Text":
    case "InlineCode":
      return [node.text];
    case "ImageAlt":
      return [node.alt];
    case "Break":
      return [];
    case "Strong":
    case "Emphasis":
    case "Delete":
    case "Link":
      return node.children.flatMap(inlineLeaves);
  }
};

const blockLeaves = (node: Block): ReadonlyArray<string> => {
  switch (node._tag) {
    case "Paragraph":
    case "Heading":
      return node.children.flatMap(inlineLeaves);
    case "List":
      return node.items.flatMap((item) => item.flatMap(blockLeaves));
    case "Quote":
      return node.children.flatMap(blockLeaves);
    case "Code":
    case "Html":
      return [node.text];
    case "Rule":
      return [];
    case "Table":
      return node.rows.flatMap((row) => row.flatMap((cell) => cell.flatMap(inlineLeaves)));
  }
};

const blank = (nodes: ReadonlyArray<Inline>) =>
  nodes.flatMap(inlineLeaves).every((text) => text.trim() === "");

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

const link = (
  url: string,
  children: ReadonlyArray<Mdast.PhrasingContent>,
  definitions: Definitions,
): Array<Inline> => {
  const content = inlines(children, definitions);
  if (blank(content)) return content;
  const safe = safeUrl(url);
  if (safe === null) return content;
  const text = content.length === 1 && content[0]?._tag === "Text" ? content[0].text : null;
  return text === url && url.length > longUrl && safe.protocol !== "mailto:"
    ? [
        {
          _tag: "Link",
          href: safe.href,
          title: url,
          children: [{ _tag: "Text", text: shortUrl(safe) }],
        },
      ]
    : [{ _tag: "Link", href: safe.href, title: null, children: content }];
};

const inline = (node: Mdast.PhrasingContent, definitions: Definitions): Array<Inline> => {
  switch (node.type) {
    case "text":
    case "html":
      return node.value === "" ? [] : [{ _tag: "Text", text: node.value }];
    case "inlineCode":
      return [{ _tag: "InlineCode", text: node.value }];
    case "break":
      return [{ _tag: "Break" }];
    case "strong":
    case "emphasis":
    case "delete": {
      const children = inlines(node.children, definitions);
      const tag =
        node.type === "strong" ? "Strong" : node.type === "emphasis" ? "Emphasis" : "Delete";
      return children.length === 0 ? [] : [{ _tag: tag, children }];
    }
    case "link":
      return link(node.url, node.children, definitions);
    case "linkReference": {
      const url = definitions.get(node.identifier);
      return url === undefined
        ? inlines(node.children, definitions)
        : link(url, node.children, definitions);
    }
    case "image":
    case "imageReference": {
      const alt = node.alt?.trim() ?? "";
      return alt === "" ? [] : [{ _tag: "ImageAlt", alt }];
    }
    case "footnoteReference":
      return [{ _tag: "Text", text: `[${node.label ?? node.identifier}]` }];
  }
};

const inlines = (
  nodes: ReadonlyArray<Mdast.PhrasingContent>,
  definitions: Definitions,
): Array<Inline> =>
  nodes
    .flatMap((node) => inline(node, definitions))
    .reduce<Array<Inline>>((merged, node) => {
      const last = merged.at(-1);
      if (node._tag === "Text" && last?._tag === "Text") {
        merged[merged.length - 1] = { _tag: "Text", text: last.text + node.text };
      } else {
        merged.push(node);
      }
      return merged;
    }, []);

const listItem = (item: Mdast.ListItem, definitions: Definitions): ReadonlyArray<Block> => {
  const content = blocks(item.children, definitions);
  if (item.checked === null || item.checked === undefined) return content;
  const box: Inline = { _tag: "Text", text: item.checked ? "[x] " : "[ ] " };
  const [first, ...rest] = content;
  return first?._tag === "Paragraph"
    ? [{ _tag: "Paragraph", children: [box, ...first.children] }, ...rest]
    : [{ _tag: "Paragraph", children: [box] }, ...content];
};

const block = (node: Mdast.RootContent, definitions: Definitions): Array<Block> => {
  switch (node.type) {
    case "paragraph": {
      const children = inlines(node.children, definitions);
      return blank(children) ? [] : [{ _tag: "Paragraph", children }];
    }
    case "heading": {
      const children = inlines(node.children, definitions);
      return blank(children) ? [] : [{ _tag: "Heading", depth: node.depth, children }];
    }
    case "thematicBreak":
      return [{ _tag: "Rule" }];
    case "blockquote": {
      const children = blocks(node.children, definitions);
      return children.length === 0 ? [] : [{ _tag: "Quote", children }];
    }
    case "list": {
      const items = node.children
        .map((item) => listItem(item, definitions))
        .filter((item) => item.length > 0);
      return items.length === 0
        ? []
        : [{ _tag: "List", ordered: node.ordered === true, start: node.start ?? null, items }];
    }
    case "code":
      return node.value === "" ? [] : [{ _tag: "Code", text: node.value }];
    case "html":
      return [{ _tag: "Html", text: node.value }];
    case "table":
      return [
        {
          _tag: "Table",
          rows: node.children.map((row) =>
            row.children.map((cell) => inlines(cell.children, definitions)),
          ),
        },
      ];
    case "footnoteDefinition":
      return blocks(node.children, definitions);
    default:
      return [];
  }
};

const blocks = (nodes: ReadonlyArray<Mdast.RootContent>, definitions: Definitions): Array<Block> =>
  nodes.flatMap((node) => block(node, definitions));

const collectDefinitions = (node: Mdast.Nodes, into: Map<string, string>) => {
  if (node.type === "definition" && !into.has(node.identifier)) into.set(node.identifier, node.url);
  if ("children" in node) for (const child of node.children) collectDefinitions(child, into);
  return into;
};

export const visible = (markdown: string): Visible => {
  const cached = trees.get(markdown);
  if (cached !== undefined) return cached;
  const root = fromMarkdown(markdown, options);
  const tree = blocks(root.children, collectDefinitions(root, new Map()));
  const oldest = trees.keys().next();
  if (trees.size >= cacheLimit && oldest.done !== true) trees.delete(oldest.value);
  trees.set(markdown, tree);
  return tree;
};

export const leaves = (tree: Visible): ReadonlyArray<string> => tree.flatMap(blockLeaves);

export const plainText = (markdown: string) => leaves(visible(markdown)).join(" ");
