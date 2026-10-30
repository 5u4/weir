import type { Root } from "@weir/daemon/Markdown";
import { segments } from "@weir/daemon/Match";
import type { ElementContent } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

export function Marked({
  segments: parts,
}: {
  segments: ReadonlyArray<{ readonly text: string; readonly mark: boolean }>;
}) {
  return parts.map(({ text, mark }, at) =>
    mark ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed split of one string
      <mark key={at}>{text}</mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed split of one string
      <Fragment key={at}>{text}</Fragment>
    ),
  );
}

export function Highlighted({ text, pattern }: { text: string; pattern: RegExp | null }) {
  return pattern === null ? text : <Marked segments={segments(text, pattern)} />;
}

const marked = (node: ElementContent, pattern: RegExp): Array<ElementContent> =>
  node.type === "text"
    ? segments(node.value, pattern).map(({ text, mark }) =>
        mark
          ? {
              type: "element",
              tagName: "mark",
              properties: {},
              children: [{ type: "text", value: text }],
            }
          : { type: "text", value: text },
      )
    : node.type === "element"
      ? [{ ...node, children: node.children.flatMap((child) => marked(child, pattern)) }]
      : [node];

export function Prose({ tree, pattern }: { tree: Root; pattern: RegExp | null }) {
  return toJsxRuntime(
    pattern === null
      ? tree
      : {
          ...tree,
          children: tree.children.flatMap((child) =>
            child.type === "doctype" ? [] : marked(child, pattern),
          ),
        },
    { Fragment, jsx, jsxs },
  );
}
