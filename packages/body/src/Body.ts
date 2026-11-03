import type { BodyFormat, ItemBody } from "@weir/contract/Source";
import * as Arr from "effect/Array";
import type { RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { toText } from "hast-util-to-text";
import { hastParsingHtml, type Root } from "./Markdown.ts";

export interface Derived {
  readonly bodyNew: string;
  readonly text: string;
  readonly textNew: string;
}

const stripQuoted = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const end = lines.findIndex(
    (line, index) =>
      /^--\s?$/.test(line) ||
      (/^\s*On\s/.test(line) &&
        Arr.takeWhile(lines.slice(index, index + 4), (candidate) => candidate.trim() !== "").some(
          (candidate) => /\bwrote:\s*$/.test(candidate),
        )),
  );
  return (end === -1 ? lines : lines.slice(0, end))
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
};

const markdownTree = hastParsingHtml((html) =>
  fromHtml(html, { fragment: true }).children.flatMap((node) =>
    node.type === "doctype" ? [] : [node],
  ),
);

const trees: Record<BodyFormat, (source: string) => Root> = {
  markdown: markdownTree,
  html: (source) => fromHtml(source),
};

const fillerJoiner =
  /(?<![\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}])[\u200C\u200D]|[\u200C\u200D](?![\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}])/gu;

// Parsers drop or replace U+0000 in text, so it cannot collide with content.
const sealPre = (nodes: Array<RootContent>, pre: Array<string>) => {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (node.tagName !== "pre") {
      sealPre(node.children, pre);
      continue;
    }
    const text = toText(node);
    if (text !== "") node.children = [{ type: "text", value: `\0${pre.push(text) - 1}\0` }];
  }
};

const visibleText = (tree: Root) => {
  const pre: Array<string> = [];
  sealPre(tree.children, pre);
  const segments = toText(tree).split(/\0(\d+)\0/u);
  return segments
    .map((segment, index) => {
      if (index % 2 === 1) return pre[Number(segment)] ?? "";
      const prose = segment
        .replace(/[\u034F\u00AD\u200B\u2060\uFEFF]/gu, "")
        .replace(fillerJoiner, "")
        .replace(/[^\S\n]+/gu, " ")
        .replace(/ ?\n ?/gu, "\n")
        .replace(/\n{3,}/gu, "\n\n");
      const started = index === 0 ? prose.trimStart() : prose;
      return index === segments.length - 1 ? started.trimEnd() : started;
    })
    .join("");
};

export const derive = (content: ItemBody): Derived => {
  const tree = trees[content.format];
  const bodyNew = content.bodyNew ?? stripQuoted(content.body);
  return {
    bodyNew,
    text: visibleText(tree(content.body)),
    textNew: visibleText(tree(bodyNew)),
  };
};
