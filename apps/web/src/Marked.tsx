import type { Root } from "@weir/daemon/Markdown";
import { segments } from "@weir/daemon/Match";
import type { Element, ElementContent } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

const markClass = "-mx-em-0.1 rounded-xs bg-mk px-em-0.1 text-mk-ink box-decoration-clone";

export const proseClass = "whitespace-pre-line *:first:mt-0 *:last:mb-0";

const headingClass = "mt-em-1 mb-em-0.4 text-em-base leading-snug";
const listClass = "mt-em-0.4 mb-em-0.7 pl-em-1.4";
const cellClass = "border border-line-2 px-2 py-1 text-left align-top";
const linkClass =
  "text-inherit underline decoration-link-rule underline-offset-2 hover:decoration-current";

const tagClass: Partial<Record<string, string>> = {
  h3: headingClass,
  h4: headingClass,
  h5: headingClass,
  h6: headingClass,
  ul: listClass,
  ol: listClass,
  table: "my-em-0.6 block max-w-full overflow-x-auto border-collapse text-em-sm",
  th: cellClass,
  td: cellClass,
  pre: "overflow-x-auto rounded-lg bg-code px-3 py-2.5 font-mono text-xs leading-normal whitespace-pre",
  blockquote: "mx-0 my-em-0.6 border-l-thick border-l-quote-rule pl-3.5 text-quote",
  hr: "mx-0 my-em-1 h-px border-none bg-line-2",
};

const hinted = (node: Element, hint: "b-img" | "b-html" | "url") => {
  const names = node.properties.className;
  return Array.isArray(names) && names.includes(hint);
};

const elementClass = (node: Element, parent: string) => {
  switch (node.tagName) {
    case "p": {
      const spacingClass = parent === "li" ? "my-0" : "mt-0 mb-em-0.7";
      return hinted(node, "b-html") ? `${spacingClass} whitespace-pre-wrap` : spacingClass;
    }
    case "a":
      return hinted(node, "url") ? `${linkClass} text-em-sm` : linkClass;
    case "span":
      return hinted(node, "b-img")
        ? "rounded-sm border border-dashed border-alt-rule px-1.5 text-em-sm text-alt box-decoration-clone"
        : undefined;
    case "code":
      return parent === "pre"
        ? "font-mono"
        : "rounded-sm bg-code px-1 py-px font-mono text-em-sm leading-auto font-normal not-italic whitespace-pre-wrap";
    default:
      return tagClass[node.tagName];
  }
};

export function Marked({
  segments: parts,
}: {
  segments: ReadonlyArray<{ readonly text: string; readonly mark: boolean }>;
}) {
  return parts.map(({ text, mark }, at) =>
    mark ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed split of one string
      <mark key={at} className={markClass}>
        {text}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed split of one string
      <Fragment key={at}>{text}</Fragment>
    ),
  );
}

export function Highlighted({ text, pattern }: { text: string; pattern: RegExp | null }) {
  return pattern === null ? text : <Marked segments={segments(text, pattern)} />;
}

const styled = (
  node: ElementContent,
  parent: string,
  pattern: RegExp | null,
): Array<ElementContent> => {
  if (node.type === "text") {
    return pattern === null
      ? [node]
      : segments(node.value, pattern).map(({ text, mark }) =>
          mark
            ? {
                type: "element",
                tagName: "mark",
                properties: { className: [markClass] },
                children: [{ type: "text", value: text }],
              }
            : { type: "text", value: text },
        );
  }
  if (node.type !== "element") return [node];
  const className = elementClass(node, parent);
  return [
    {
      ...node,
      properties: {
        ...node.properties,
        className: className === undefined ? undefined : [className],
      },
      children: node.children.flatMap((child) => styled(child, node.tagName, pattern)),
    },
  ];
};

export function Prose({ tree, pattern }: { tree: Root; pattern: RegExp | null }) {
  return toJsxRuntime(
    {
      ...tree,
      children: tree.children.flatMap((child) =>
        child.type === "doctype" ? [] : styled(child, "root", pattern),
      ),
    },
    { Fragment, jsx, jsxs },
  );
}
