import * as Option from "effect/Option";

export type Chip =
  | { readonly key: "from"; readonly value: string }
  | { readonly key: "in"; readonly value: string }
  | { readonly key: "source"; readonly value: string };

export type Query = { readonly text: string; readonly chips: ReadonlyArray<Chip> };

export type Field = { readonly chips: ReadonlyArray<Chip>; readonly rest: string };

export type SearchParams = {
  readonly q: string;
  readonly tag?: string;
  readonly from?: string;
  readonly source?: string;
};

const untagged = "Untagged";
const fieldToken = /^(from|in|source):(\S+)$/iu;

const chipOf = (token: string, tags: ReadonlyArray<string>): Chip | null => {
  const [, rawKey = "", value = ""] = fieldToken.exec(token) ?? [];
  const key = rawKey.toLowerCase();
  if (key === "from" || key === "source") return { key, value };
  if (key !== "in") return null;
  const name = [...tags, untagged].find((tag) => tag.toLowerCase() === value.toLowerCase());
  return name === undefined ? null : { key, value: name };
};

const withChip = (chips: ReadonlyArray<Chip>, chip: Chip) => [
  ...chips.filter(({ key }) => key !== chip.key),
  chip,
];

export const parseQuery = (q: string, tags: ReadonlyArray<string>): Query => {
  const words: Array<string> = [];
  let chips: ReadonlyArray<Chip> = [];
  for (const token of q.split(/\s+/u)) {
    if (token === "") continue;
    const chip = chipOf(token, tags);
    if (chip === null) words.push(token);
    else chips = withChip(chips, chip);
  }
  return { text: words.join(" "), chips };
};

export const chipText = ({ key, value }: Chip) => `${key}:${value}`;

export const queryText = ({ text, chips }: Query) =>
  [...chips.map(chipText), text].filter((part) => part !== "").join(" ");

export const searchParams = ({ text, chips }: Query): Option.Option<SearchParams> => {
  if (text === "" && chips.length === 0) return Option.none();
  const valueOf = (key: Chip["key"]) => chips.find((chip) => chip.key === key)?.value;
  const tag = valueOf("in");
  const from = valueOf("from");
  const source = valueOf("source");
  return Option.some({
    q: text,
    ...(tag === undefined ? {} : { tag }),
    ...(from === undefined ? {} : { from }),
    ...(source === undefined ? {} : { source }),
  });
};

export const sameParams = (left: SearchParams, right: SearchParams) =>
  left.q === right.q &&
  left.tag === right.tag &&
  left.from === right.from &&
  left.source === right.source;

export const typed = (
  field: Field,
  text: string,
  tags: ReadonlyArray<string>,
  done: boolean,
): Field => {
  let chips = field.chips;
  const kept: Array<string> = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const closed = done || match.index + match[0].length < text.length;
    const chip = closed ? chipOf(match[0], tags) : null;
    if (chip === null) kept.push(match[0]);
    else chips = withChip(chips, chip);
  }
  if (chips === field.chips) return { chips, rest: text };
  const trailing = done || kept.length === 0 ? "" : (/\s*$/u.exec(text)?.[0] ?? "");
  return { chips, rest: `${kept.join(" ")}${trailing}` };
};

export const fieldOf = (q: string, tags: ReadonlyArray<string>): Field =>
  typed({ chips: [], rest: "" }, q, tags, false);

export const queryOf = ({ chips, rest }: Field) =>
  chips.length === 0 ? rest : `${chips.map(chipText).join(" ")} ${rest.trimStart()}`;
