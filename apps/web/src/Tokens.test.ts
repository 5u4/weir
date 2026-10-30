import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const runtime = [
  "--b",
  "--bh",
  "--cap-h",
  "--dx",
  "--dy",
  "--g",
  "--h",
  "--i",
  "--leave-opacity",
  "--leave-translate",
  "--p",
  "--view-h",
  "--view-top",
  "--w",
  "--was-opacity",
  "--x",
  "--y",
];

const sheets = [
  "theme.css",
  ...readdirSync(new URL("./styles/", import.meta.url)).map((name) => `styles/${name}`),
].map((path) => ({ path, text: readFileSync(new URL(`./${path}`, import.meta.url), "utf8") }));

it("every var() in the web styles names a declared custom property or a var set at runtime", () => {
  const declared = new Set([
    ...runtime,
    ...sheets.flatMap(({ text }) =>
      [...text.matchAll(/(?:^|[\s;{])(--[\w\\.-]+)\s*:|@property\s+(--[\w\\.-]+)/g)].map(
        (match) => match[1] ?? match[2],
      ),
    ),
  ]);
  const unresolved = sheets.flatMap(({ path, text }) =>
    [...text.matchAll(/var\(\s*(--[\w\\.-]+)/g)]
      .map((match) => match[1])
      .filter((name) => !declared.has(name))
      .map((name) => `${path}: ${name}`),
  );
  expect(unresolved).toEqual([]);
});
