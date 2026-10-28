export const stripQuoted = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const attribution = lines.findIndex(
    (line, index) =>
      /^\s*On\s/.test(line) &&
      [line, lines[index + 1] ?? ""].some((candidate) => /\bwrote:\s*$/.test(candidate)),
  );
  return (attribution === -1 ? lines : lines.slice(0, attribution))
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .trim();
};
