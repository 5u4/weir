export const termPattern = (query: string) => {
  const terms = query
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .toSorted((left, right) => right.length - left.length);
  if (terms.length === 0) return null;
  return new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
};

export const segments = (text: string, pattern: RegExp) => {
  const result: Array<{ text: string; mark: boolean }> = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) result.push({ text: text.slice(at, match.index), mark: false });
    result.push({ text: match[0], mark: true });
    at = match.index + match[0].length;
  }
  if (at < text.length) result.push({ text: text.slice(at), mark: false });
  return result;
};

export const senderLabel = (name: string, address: string) =>
  name === "" ? address : `${name} <${address}>`;
