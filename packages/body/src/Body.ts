import type { BodyFormat, ItemBody } from "@weir/contract/Source";
import * as Arr from "effect/Array";
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

const visibleText = (tree: Root) =>
  toText(tree)
    .replace(/[\u034F\u00AD\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

export const derive = (content: ItemBody): Derived => {
  const tree = trees[content.format];
  const bodyNew = content.bodyNew ?? stripQuoted(content.body);
  return {
    bodyNew,
    text: visibleText(tree(content.body)),
    textNew: visibleText(tree(bodyNew)),
  };
};
