export const stripQuoted = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const end = lines.findIndex(
    (line, index) =>
      /^--\s?$/.test(line) ||
      (/^\s*On\s/.test(line) &&
        [line, lines[index + 1] ?? ""].some((candidate) => /\bwrote:\s*$/.test(candidate))),
  );
  return (end === -1 ? lines : lines.slice(0, end))
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
};
