import type { Element, Root as HastRoot } from "hast";
import { fromHtml } from "hast-util-from-html";
import { defaultHandlers as htmlHandlers, toMdast } from "hast-util-to-mdast";
import type { Link, Nodes, Parents, PhrasingContent, Root, RootContent } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import {
  type Handlers,
  defaultHandlers as markdownHandlers,
  toMarkdown,
} from "mdast-util-to-markdown";

const QUOTED = ["gmail_signature", "gmail_quote", "gmail_attr"];

const unquote = (parent: HastRoot | Element) => {
  parent.children = parent.children.filter((child) => {
    const classes = child.type === "element" ? child.properties.className : undefined;
    return !(Array.isArray(classes) && classes.some((name) => QUOTED.includes(String(name))));
  });
  for (const child of parent.children) if (child.type === "element") unquote(child);
};

const ATTENTION: Record<string, true> = { strong: true, emphasis: true, delete: true };
const PHRASING: Record<string, true> = {
  ...ATTENTION,
  link: true,
  text: true,
  break: true,
  image: true,
  inlineCode: true,
  html: true,
};
const BLANK = /^[\s\u200b\u200c\u2060\ufeff]*$/u;
const LEADING_SPACE = /^[\p{Zs}\t\n\f\r]+/u;
const TRAILING_SPACE = /[\p{Zs}\t\n\f\r]+$/u;
const URL = /(?<![a-z])https?:\/\/[^\s<>"]+/giu;
const URL_TRAIL = `!"'),.:;?*_~`;

type Wrapper = Extract<PhrasingContent, Parents>;

const isPhrasing = (node: RootContent): node is PhrasingContent => PHRASING[node.type] === true;

const blank = (node: Nodes): boolean =>
  node.type === "text"
    ? BLANK.test(node.value)
    : node.type === "break" || ("children" in node && node.children.every(blank));

const urlEnd = (url: string) => {
  let end = url.length;
  let unmatched = url.split(")").length - url.split("(").length;
  for (;;) {
    const char = url[end - 1] ?? "";
    if (char === ")" && unmatched > 0) unmatched--;
    else if (char === ")" || !URL_TRAIL.includes(char)) return end;
    end--;
  }
};

const linkify = (value: string): PhrasingContent[] => {
  const out: PhrasingContent[] = [];
  let last = 0;
  for (const match of value.matchAll(URL)) {
    const url = match[0].slice(0, urlEnd(match[0]));
    if (!/:\/\/[^/?#]/.test(url)) continue;
    if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
    out.push({ type: "link", url, children: [{ type: "text", value: url }] });
    last = match.index + url.length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
};

const hoistEdges = (node: Wrapper): PhrasingContent[] => {
  const children = [...node.children];
  const lead: PhrasingContent[] = [];
  const trail: PhrasingContent[] = [];
  for (let first = children[0]; first; first = children[0]) {
    const space = first.type === "text" ? LEADING_SPACE.exec(first.value)?.[0] : undefined;
    if (first.type !== "break" && space === undefined) break;
    if (first.type === "text" && space !== undefined && space !== first.value) {
      children[0] = { ...first, value: first.value.slice(space.length) };
      lead.push({ type: "text", value: space });
    } else lead.push(children.shift() as PhrasingContent);
  }
  for (let last = children.at(-1); last; last = children.at(-1)) {
    const space = last.type === "text" ? TRAILING_SPACE.exec(last.value)?.[0] : undefined;
    if (last.type !== "break" && space === undefined) break;
    if (last.type === "text" && space !== undefined && space !== last.value) {
      children[children.length - 1] = { ...last, value: last.value.slice(0, -space.length) };
      trail.unshift({ type: "text", value: space });
    } else trail.unshift(children.pop() as PhrasingContent);
  }
  return [...lead, ...(children.length > 0 ? [{ ...node, children } as Wrapper] : []), ...trail];
};

const merge = (nodes: ReadonlyArray<PhrasingContent>): PhrasingContent[] => {
  const out: PhrasingContent[] = [];
  for (let start = 0; start < nodes.length; ) {
    const node = nodes[start] as PhrasingContent;
    const joins = node.type === "inlineCode" || ATTENTION[node.type];
    let end = start + 1;
    while (joins && end < nodes.length && nodes[end]?.type === node.type) end++;
    const run = nodes.slice(start, end);
    start = end;
    if (run.length === 1) out.push(node);
    else if (node.type === "inlineCode") {
      out.push({ ...node, value: run.map((each) => (each as typeof node).value).join("") });
    } else {
      const children = merge(run.flatMap((each) => (each as Wrapper).children));
      out.push({ ...node, children } as Wrapper);
    }
  }
  return out;
};

const regroup = <Item, Group extends Item, Out>(
  items: ReadonlyArray<Item>,
  grouped: (item: Item) => item is Group,
  run: (group: Group[]) => Out,
  single: (item: Item) => Out,
) => {
  const out: Out[] = [];
  let pending: Group[] = [];
  const flush = () => {
    if (pending.length > 0) out.push(run(pending));
    pending = [];
  };
  for (const item of items) {
    if (grouped(item)) pending.push(item);
    else {
      flush();
      out.push(single(item));
    }
  }
  flush();
  return out;
};

const clean = (nodes: ReadonlyArray<PhrasingContent>, inside: Readonly<Record<string, true>>) =>
  merge(
    nodes.flatMap((node): PhrasingContent[] => {
      if (node.type === "text") return inside.link ? [node] : linkify(node.value);
      if (node.type === "inlineCode") return node.value === "" ? [] : [node];
      if (node.type === "link") {
        const children = clean(node.children, { ...inside, link: true });
        if (!node.url) return children;
        if (!children.some((child) => child.type === "link")) return [{ ...node, children }];
        return regroup(
          children,
          (child): child is Exclude<PhrasingContent, Link> => child.type !== "link",
          (group): PhrasingContent => ({ ...node, children: group }),
          (child) => child,
        );
      }
      if (!ATTENTION[node.type]) return [node];
      const wrapper = node as Wrapper;
      const children = clean(wrapper.children, { ...inside, [node.type]: true });
      if (inside[node.type] || children.every(blank)) return children;
      return hoistEdges({ ...wrapper, children } as Wrapper);
    }),
  );

const edge = (node: PhrasingContent | undefined) =>
  node?.type === "break" || (node?.type === "text" && node.value.trim() === "");

const tidy = (nodes: ReadonlyArray<RootContent>): RootContent[] =>
  nodes.flatMap((node): RootContent[] => {
    if (node.type !== "paragraph" && node.type !== "heading") {
      return "children" in node
        ? [{ ...node, children: tidy(node.children) } as RootContent]
        : [node];
    }
    const children = clean(node.children, {});
    while (edge(children[0])) children.shift();
    while (edge(children.at(-1))) children.pop();
    return children.length > 0 ? [{ ...node, children }] : [];
  });

const wrapInto = (block: RootContent, wrapper: Wrapper): RootContent =>
  block.type === "paragraph" || block.type === "heading"
    ? { ...block, children: [{ ...wrapper, children: block.children } as Wrapper] }
    : "children" in block
      ? ({
          ...block,
          children: block.children.map((child) => wrapInto(child, wrapper)),
        } as RootContent)
      : block;

const lift = (nodes: ReadonlyArray<RootContent>): RootContent[] =>
  nodes.flatMap((node): RootContent[] => {
    if (node.type === "paragraph" || node.type === "heading") {
      return regroup(
        lift(node.children),
        isPhrasing,
        (children): RootContent => ({ ...node, children }),
        (block) => block,
      );
    }
    if (!("children" in node)) return [node];
    if (!isPhrasing(node)) return [{ ...node, children: lift(node.children) } as RootContent];
    const inner = lift(node.children);
    if (inner.every(isPhrasing)) return [{ ...node, children: inner } as Wrapper];
    return regroup(
      inner,
      isPhrasing,
      (children): RootContent => ({ ...node, children }) as Wrapper,
      (block) => wrapInto(block, node),
    );
  });

// micromark treats these as whitespace when pairing `*` runs; CommonMark does not, so write them as references.
const MISCLASSIFIED = /[\v\u2028\u2029\ufeff]/gu;
const EMAIL =
  /^[\w.#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;

const handlers: Partial<Handlers> = {
  text: (node, parent, state, info) =>
    markdownHandlers
      .text(node, parent, state, info)
      .replace(MISCLASSIFIED, (char) => `&#x${char.codePointAt(0)?.toString(16).toUpperCase()};`),
  // mdast-util-to-markdown writes any `mailto:` link as `<address>`; micromark parses only ASCII addresses there.
  link: (node, parent, state, info) => {
    if (!node.url.startsWith("mailto:") || EMAIL.test(node.url.slice("mailto:".length))) {
      return markdownHandlers.link(node, parent, state, info);
    }
    const { options } = state;
    state.options = { ...options, resourceLink: true };
    try {
      return markdownHandlers.link(node, parent, state, info);
    } finally {
      state.options = options;
    }
  },
};

const convert = (dropQuoted: boolean) => (html: string) => {
  const hast = fromHtml(html);
  if (dropQuoted) unquote(hast);
  const mdast = toMdast(hast, {
    handlers: {
      table: htmlHandlers.div,
      tr: htmlHandlers.div,
      td: htmlHandlers.div,
      th: htmlHandlers.div,
    },
    nodeHandlers: { comment: () => undefined },
  });
  const root: Root = {
    type: "root",
    children: tidy(lift(mdast.type === "root" ? mdast.children : [])),
  };
  return toMarkdown(root, { bullet: "-", extensions: [gfmToMarkdown()], handlers }).trimEnd();
};

export const htmlBody = convert(false);
export const htmlBodyNew = convert(true);

const TAGS =
  /<\/?(?:details|summary|picture|source|img|sub|sup|br|div|span|p|a|b|i|em|strong|code|kbd|table|thead|tbody|tr|td|th|ul|ol|li|hr|h[1-6]|blockquote|pre|g-emoji)\b[^<>]*>/gi;
const DIFF = /^(?:[+\->] {2,}\S|[+-]\s*$)/;
const HUNK = /^(?:> ?)?[+-](?![-+]{2})/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const LIST = /^(?:[-*•]|\d+\.)\s+\S/;
const MARKER = /^(?:[-*•]|\d+\.)$/;
const RULE = /^(?:-{3,}|_{3,}|\*{3,}|={3,})$/;

export const plainBody = (text: string): string => {
  const lines = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&zwnj;|\u200c/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const out: string[] = [];
  let kind = "";
  const gap = () => {
    if (out.length && out.at(-1) !== "") out.push("");
    kind = "";
  };
  const emit = (next: string, line: string) => {
    if (kind && next !== kind) gap();
    out.push(line);
    kind = next;
  };
  const block = (lang: string, body: string[]) => {
    gap();
    out.push(`\`\`\`${lang}`, ...body, "```");
    gap();
  };
  const textAt = (j: number) =>
    (lines[j] ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(TAGS, "")
      .trim();
  for (let j = 0; j < lines.length; j++) {
    const raw = lines[j] ?? "";
    const fence = FENCE.exec(raw);
    if (fence) {
      const marker = fence[1] ?? "```";
      const end = lines.findIndex((l, x) => x > j && l.trim().startsWith(marker));
      const stop = end < 0 ? lines.length : end;
      block(fence[2] ?? "", lines.slice(j + 1, stop));
      j = stop;
      continue;
    }
    if (HUNK.test(raw)) {
      let k = j;
      while (k < lines.length && HUNK.test(lines[k] ?? "")) k++;
      const hunk = lines.slice(j, k);
      if (hunk.filter((l) => DIFF.test(l)).length > 2) {
        block(
          "diff",
          hunk.map((l) => l.replace(/^> ?/, " ")),
        );
        j = k - 1;
        continue;
      }
    }
    const line = textAt(j);
    if (!line) gap();
    else if (MARKER.test(line) && textAt(j + 1))
      emit("list", `${/\d/.test(line) ? line : "-"} ${textAt(++j)}`);
    else if (LIST.test(line)) emit("list", line.replace(/^•/, "-"));
    else if (RULE.test(line)) {
      gap();
      out.push(line.startsWith("=") ? `\\${line}` : line);
      gap();
    } else if (line.startsWith("|")) emit("table", line);
    else if (line.startsWith(">")) emit("quote", line);
    else emit("text", line.replace(/^\+(?=\s)/, "\\+").replace(/^(\d+)\)(?=\s)/, "$1\\)"));
  }
  return out.join("\n").trim();
};

const ATTRIBUTION = /^On .+ wrote:\s*$/;

export const plainNew = (text: string): string => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex(
    (line, i) => line === "-- " || (ATTRIBUTION.test(line) && /^>/.test(lines[i + 1] ?? "")),
  );
  return plainBody((cut < 0 ? lines : lines.slice(0, cut)).join("\n"));
};
