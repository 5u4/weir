import TurndownService from "turndown";

const QUOTED = ["gmail_signature", "gmail_quote", "gmail_attr"];

const turndown = (dropQuoted: boolean) => {
  const service = new TurndownService({
    br: "",
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  service.escape = (text) => text;
  service.remove(["style", "script", "head", "title"]);
  service.addRule("autolink", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("href") === node.textContent,
    replacement: (content) => content,
  });
  if (dropQuoted) {
    service.remove((node) => QUOTED.some((name) => node.classList?.contains(name) ?? false));
  }
  return service;
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
