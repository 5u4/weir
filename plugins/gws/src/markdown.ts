import TurndownService from "turndown";

const QUOTED = ["gmail_signature", "gmail_quote", "gmail_attr"];

const KINDS = [
  { tags: ["strong", "b"], open: "\uE000", close: "\uE001", delimiter: "**" },
  { tags: ["em", "i"], open: "\uE002", close: "\uE003", delimiter: "*" },
] as const;
const BOTH = [0, 1] as const;
type Kind = (typeof BOTH)[number];
const ATOM_OPEN = "\uE004";
const ATOM_CLOSE = "\uE005";
const TEXT_URL = "\uE006";
const AUTOLINK = "\uE007";
const WORD_JOINER = "\u2060";
const SENTINELS = /[\uE000-\uE007]|&#(?:x0*e00[0-7](?![\da-f])|0*57(?:34[4-9]|35[01])(?!\d));?/gi;
const MARKERS = /[\uE000-\uE007]/g;
const BLANK = /^[\s\u200b\u200c\u2060\ufeff]+$/u;
const INVISIBLES = /[\s\u200b\u200c\u2060\ufeff]/g;
const PARAGRAPH_BREAK = /(\n\s*\n)/;
const BLOCK_LINE =
  /\n[ \t]*(?:#{1,6}(?:[ \t]|$)|[-+*][ \t]|\d{1,9}[.)][ \t]|>|```|~~~|(?:-+|=+)[ \t]*(?:\n|$))/;
const BLOCKS = "h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, hr";
const DELIMITING = /[\\*]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
const ESCAPED =
  /((?<![A-Za-z])[hH][tT][tT][pP][sS]?:\/\/\S*|(?<=^|[\s*_~(])[wW]{3}\.\S*)|[\\*]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
const LABEL_UNSAFE = /[\\*[\]`]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
const BARE_URL =
  /^(?:https?:\/\/|www\.)[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?::\d+)?(?:[/?#][^\s<>\\`[\]]*)?$/u;
const URL_TRAIL = "?!.,:*_~)";
const DROPPED_TRAIL = `!"',.:;?*_~`;

type Class = "space" | "punctuation" | "other";

const classOf = (char: string): Class =>
  /[\p{Zs}\t\n\f\r]/u.test(char) ? "space" : /[\p{P}\p{S}]/u.test(char) ? "punctuation" : "other";

interface Unit {
  text: string;
  readonly head: Class;
  readonly tail: Class;
  readonly blank: boolean;
  readonly word: boolean;
  readonly solid: boolean;
  readonly link: -1 | 0 | 1;
  readonly marks: [boolean, boolean];
  readonly breaks: [boolean, boolean];
}

const tokenize = (marked: string): Array<Unit> => {
  const units: Array<Unit> = [];
  const depth: [number, number] = [0, 0];
  let atom: string | undefined;
  let prefix: string | undefined = "";
  let backslash = false;
  const add = (text: string, link: Unit["link"], isAtom: boolean) => {
    const chars = Array.from(text);
    const head = classOf(chars[0] ?? "");
    const tail = classOf(chars.at(-1) ?? "");
    const blank = !isAtom && BLANK.test(text);
    const word = !isAtom && !blank && chars.length === 1 && head === "other";
    const solid = isAtom && link === 0;
    const marks: [boolean, boolean] = [depth[0] > 0, depth[1] > 0];
    const previous = units.at(-1);
    if (word && previous?.word && previous.marks.every((mark, kind) => mark === marks[kind])) {
      previous.text += text;
      return;
    }
    units.push({ text, head, tail, blank, word, solid, link, marks, breaks: [false, false] });
  };
  const endPrefix = () => {
    if (prefix) {
      const text = prefix;
      units.push({
        text,
        head: "space",
        tail: "space",
        blank: true,
        word: false,
        solid: true,
        link: 0,
        marks: [false, false],
        breaks: [false, false],
      });
    }
    prefix = undefined;
  };
  const flush = () => {
    if (backslash) add("\\", 0, false);
    backslash = false;
  };
  for (const char of marked) {
    if (atom !== undefined) {
      if (char !== ATOM_CLOSE) atom += char;
      else {
        add(atom, atom.startsWith("[") ? 1 : atom.startsWith("]") ? -1 : 0, true);
        atom = undefined;
      }
      continue;
    }
    if (prefix !== undefined) {
      if (char === ">" || char === " " || char === "\t") {
        prefix += char;
        continue;
      }
      endPrefix();
    }
    const kind = BOTH.find((each) => char === KINDS[each].open || char === KINDS[each].close);
    if (kind !== undefined) {
      flush();
      depth[kind] += char === KINDS[kind].open ? 1 : -1;
    } else if (char === ATOM_OPEN) {
      flush();
      atom = "";
    } else if (backslash) {
      backslash = false;
      add(`\\${char}`, 0, false);
    } else if (char === "\\") backslash = true;
    else add(char, 0, false);
    if (char === "\n") prefix = "";
  }
  flush();
  endPrefix();
  return units;
};

const endsUrl = (units: ReadonlyArray<Unit>, from: number) => {
  for (let index = from; index < units.length; index++) {
    for (const char of units[index]?.text ?? "") {
      if (" \t\n".includes(char)) return true;
      if (!URL_TRAIL.includes(char)) return false;
    }
  }
  return true;
};

const count = (text: string, char: string) => text.split(char).length - 1;

const urlEnd = (url: string) => {
  let end = url.length;
  let unmatched = count(url, ")") - count(url, "(");
  for (;;) {
    const char = url[end - 1] ?? "";
    if (char !== "" && DROPPED_TRAIL.includes(char)) end--;
    else if (char === ")" && unmatched > 0) {
      end--;
      unmatched--;
    } else return end;
  }
};

const bare = (url: string, autolink: boolean) =>
  BARE_URL.test(url) &&
  (!autolink || url.startsWith("http")) &&
  urlEnd(url) === url.length &&
  count(url, "(") === count(url, ")");

const anchor = (units: ReadonlyArray<Unit>) => {
  let depth = 0;
  return units.flatMap((unit, index) => {
    depth += unit.link;
    const kind = unit.solid ? unit.text[0] : undefined;
    if (kind !== AUTOLINK && kind !== TEXT_URL) return [unit];
    const url = unit.text.slice(1);
    const before = units[index - 1]?.text.at(-1) ?? " ";
    const opens = url.startsWith("www.") ? /[ \t\n(*_~]/.test(before) : !/[A-Za-z]/.test(before);
    const safe = depth === 0 && opens && endsUrl(units, index + 1);
    if (safe && bare(url, kind === AUTOLINK)) return [{ ...unit, text: url }];
    const label = url.replace(LABEL_UNSAFE, "\\$&");
    const markdown =
      kind === AUTOLINK
        ? `${atom("[")}${label}${atom(`](${url.replace(/[()]/g, "\\$&")})`)}`
        : label.replace(/(https?(?=:)|www(?=\.))(.)/gi, "$1\\$2");
    return tokenize(markdown).map((part) => ({
      ...part,
      marks: [...unit.marks] as [boolean, boolean],
    }));
  });
};

const runs = (units: ReadonlyArray<Unit>, kind: Kind) => {
  const found: Array<[number, number]> = [];
  units.forEach((unit, index) => {
    if (!unit.marks[kind]) return;
    const last = found.at(-1);
    if (last?.[1] === index - 1 && !unit.breaks[kind]) last[1] = index;
    else found.push([index, index]);
  });
  return found;
};

const balanced = (units: ReadonlyArray<Unit>, first: number, last: number) => {
  let depth = 0;
  for (let index = first; index <= last; index++) {
    depth += units[index]?.link ?? 0;
    if (depth < 0) return false;
  }
  return depth === 0;
};

// A `*` run with punctuation on both sides can both open and close, so CommonMark may mis-pair it.
const stuck = (unit: Unit, edge: Class, outside: Class) =>
  edge === "punctuation" && (unit.solid ? outside === "other" : outside !== "space");

const trim = (units: Array<Unit>, kind: Kind) => {
  const tailBefore = (index: number) => units[index - 1]?.tail ?? "space";
  const headAfter = (index: number) => units[index + 1]?.head ?? "space";
  let split = true;
  while (split) {
    split = false;
    for (const [start, end] of runs(units, kind)) {
      let first = start;
      let last = end;
      for (let unit = units[first]; unit && first <= last; unit = units[++first]) {
        if (!unit.blank && !stuck(unit, unit.head, tailBefore(first))) break;
        unit.marks[kind] = false;
      }
      for (let unit = units[last]; unit && last >= first; unit = units[--last]) {
        if (!unit.blank && !stuck(unit, unit.tail, headAfter(last))) break;
        unit.marks[kind] = false;
      }
      if (first > last || balanced(units, first, last)) continue;
      for (let index = first; index <= last; index++) {
        const unit = units[index];
        if (unit && unit.link !== 0) unit.marks[kind] = false;
      }
      split = true;
    }
  }
};

const settle = (units: Array<Unit>) => {
  let unsettled = true;
  while (unsettled) {
    for (const kind of BOTH) trim(units, kind);
    const previous = units.map((unit) => [...unit.breaks]);
    for (const unit of units) unit.breaks.fill(false);
    const [strong, em] = BOTH.map((kind) => runs(units, kind));
    for (const [outer, inner, kind] of [
      [strong, em, 1],
      [em, strong, 0],
    ] as const) {
      let next = 0;
      for (const [start, end] of outer ?? []) {
        while ((inner?.[next]?.[0] ?? Number.POSITIVE_INFINITY) <= start) next++;
        for (let index = next; (inner?.[index]?.[0] ?? Number.POSITIVE_INFINITY) <= end; index++) {
          const after = units[end + 1];
          if (after && (inner?.[index]?.[1] ?? 0) > end) after.breaks[kind] = true;
        }
      }
    }
    unsettled = units.some((unit, index) =>
      unit.breaks.some((broken, kind) => broken !== previous[index]?.[kind]),
    );
  }
  return units;
};

const serialize = (units: ReadonlyArray<Unit>) => {
  const ends = BOTH.map((kind) => {
    const end: Array<number> = [];
    let current = -1;
    for (let index = units.length - 1; index >= 0; index--) {
      const fresh = current === -1 || units[index + 1]?.breaks[kind] === true;
      current = units[index]?.marks[kind] ? (fresh ? index : current) : -1;
      end[index] = current;
    }
    return end;
  });
  const open: Array<Kind> = [];
  let markdown = "";
  for (let index = 0; index <= units.length; index++) {
    const unit = units[index];
    const marks = unit?.marks ?? [false, false];
    const cut = open.findIndex((kind) => !marks[kind] || unit?.breaks[kind]);
    const closing = cut === -1 ? [] : open.splice(cut).reverse();
    const opening = BOTH.filter((kind) => marks[kind] && !open.includes(kind)).sort(
      (left, right) => (ends[right]?.[index] ?? 0) - (ends[left]?.[index] ?? 0) || left - right,
    );
    for (const kind of [...closing, ...opening]) markdown += KINDS[kind].delimiter;
    open.push(...opening);
    if (!unit) continue;
    const previous = units[index - 1];
    if (unit.link === 1 && closing.length + opening.length === 0 && previous?.text === "!") {
      markdown = `${markdown.slice(0, -1)}\\!`;
    }
    const glued = closing.length + opening.length === 0 && unit.solid && previous?.solid;
    if (glued && previous.text.endsWith("`") && unit.text.startsWith("`")) markdown += WORD_JOINER;
    markdown += unit.text;
  }
  return markdown;
};

const wrap = (open: string, close: string, text: string) => {
  const inner = text.trim();
  if (inner === "") return text;
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  return `${lead}${open}${inner}${close}${trail}`;
};

const emphasis =
  ({ open, close }: (typeof KINDS)[number]) =>
  (content: string, node: TurndownService.Node) =>
    (node.textContent ?? "").replace(INVISIBLES, "") === "" ||
    BLOCK_LINE.test(content.trim()) ||
    node.querySelectorAll(BLOCKS).length > 0
      ? content
      : content
          .split(PARAGRAPH_BREAK)
          .map((piece) => wrap(open, close, piece))
          .join("");

const atom = (markdown: string) => (markdown === "" ? "" : `${ATOM_OPEN}${markdown}${ATOM_CLOSE}`);

const turndown = (dropQuoted: boolean) => {
  const options: TurndownService.Options = {
    br: "",
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  };
  const builtIn = new TurndownService(options);
  const markdownOf: TurndownService.ReplacementFunction = (content, node, settings) =>
    builtIn.rules.forNode(node).replacement?.(content, node, settings) ?? content;
  const service = new TurndownService(options);
  service.escape = (text) =>
    text.replace(ESCAPED, (match, url: string | undefined) => {
      if (url === undefined) return `\\${match}`;
      const end = urlEnd(url);
      return `${atom(`${TEXT_URL}${url.slice(0, end)}`)}${url.slice(end).replace(DELIMITING, "\\$&")}`;
    });
  service.remove(["style", "script", "head", "title"]);
  service.addRule("atomicCode", {
    filter: (node) =>
      node.nodeName === "CODE" &&
      !(node.parentNode?.nodeName === "PRE" && !node.previousSibling && !node.nextSibling),
    replacement: (content, node, settings) =>
      atom(markdownOf(content.replace(MARKERS, ""), node, settings)),
  });
  service.addRule("atomicImage", {
    filter: "img",
    replacement: (...args) => atom(markdownOf(...args)),
  });
  service.addRule("atomicLink", {
    filter: (node) => node.nodeName === "A" && Boolean(node.getAttribute("href")),
    replacement: (content, node, settings) =>
      `${atom("[")}${content}${atom(markdownOf(content, node, settings).slice(content.length + 1))}`,
  });
  service.addRule("autolink", {
    filter: (node) =>
      node.nodeName === "A" &&
      node.children.length === 0 &&
      node.getAttribute("href") === node.textContent,
    replacement: (_, node) => atom(node.textContent ? `${AUTOLINK}${node.textContent}` : ""),
  });
  for (const kind of KINDS) {
    service.addRule(kind.tags[0], { filter: [...kind.tags], replacement: emphasis(kind) });
  }
  if (dropQuoted) {
    service.addRule("quoted", {
      filter: (node) => QUOTED.some((name) => node.classList?.contains(name) ?? false),
      replacement: () => "",
    });
  }
  return (html: string) =>
    serialize(settle(anchor(tokenize(service.turndown(html.replace(SENTINELS, "\uFFFD"))))));
};

export const htmlBody = turndown(false);
export const htmlBodyNew = turndown(true);

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
