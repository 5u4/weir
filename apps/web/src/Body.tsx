import type { Block, Inline, Visible } from "@weir/daemon/Markdown";
import { createElement, Fragment, type ReactNode } from "react";
import { Highlighted } from "./Marked.tsx";

const inline = (node: Inline, pattern: RegExp | null): ReactNode => {
  const children = (nodes: ReadonlyArray<Inline>) => nodes.map((child) => inline(child, pattern));
  switch (node._tag) {
    case "Text":
      return <Highlighted text={node.text} pattern={pattern} />;
    case "InlineCode":
      return (
        <code>
          <Highlighted text={node.text} pattern={pattern} />
        </code>
      );
    case "ImageAlt":
      return (
        <span className="b-img">
          <Highlighted text={node.alt} pattern={pattern} />
        </span>
      );
    case "Break":
      return <br />;
    case "Strong":
      return createElement("strong", null, ...children(node.children));
    case "Emphasis":
      return createElement("em", null, ...children(node.children));
    case "Delete":
      return createElement("del", null, ...children(node.children));
    case "Link":
      return node.href === null
        ? createElement(Fragment, null, ...children(node.children))
        : createElement(
            "a",
            {
              href: node.href,
              target: "_blank",
              rel: "noreferrer noopener",
              ...(node.title === null ? {} : { title: node.title, className: "url" }),
            },
            ...children(node.children),
          );
  }
};

const block = (node: Block, pattern: RegExp | null): ReactNode => {
  const inlines = (nodes: ReadonlyArray<Inline>) => nodes.map((child) => inline(child, pattern));
  switch (node._tag) {
    case "Paragraph":
      return createElement("p", null, ...inlines(node.children));
    case "Heading":
      return createElement(`h${Math.min(node.depth + 2, 6)}`, null, ...inlines(node.children));
    case "List":
      return createElement(
        node.ordered ? "ol" : "ul",
        node.start === null || node.start === 1 ? null : { start: node.start },
        ...node.items.map((item) =>
          createElement("li", null, ...item.map((child) => block(child, pattern))),
        ),
      );
    case "Quote":
      return createElement(
        "blockquote",
        null,
        ...node.children.map((child) => block(child, pattern)),
      );
    case "Code":
      return (
        <pre>
          <code>
            <Highlighted text={node.text} pattern={pattern} />
          </code>
        </pre>
      );
    case "Rule":
      return <hr />;
    case "Table": {
      const [head, ...rows] = node.rows;
      const row = (cells: ReadonlyArray<ReadonlyArray<Inline>>, cell: "th" | "td") =>
        createElement(
          "tr",
          null,
          ...cells.map((content) => createElement(cell, null, ...inlines(content))),
        );
      return (
        <table>
          {head !== undefined && <thead>{row(head, "th")}</thead>}
          {createElement("tbody", null, ...rows.map((cells) => row(cells, "td")))}
        </table>
      );
    }
    case "Html":
      return (
        <p className="b-html">
          <Highlighted text={node.text} pattern={pattern} />
        </p>
      );
  }
};

export function Body({ tree, pattern }: { tree: Visible; pattern: RegExp | null }) {
  return createElement("div", { className: "body" }, ...tree.map((node) => block(node, pattern)));
}
