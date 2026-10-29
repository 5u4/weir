import { segments } from "@weir/daemon/Match";
import { Fragment } from "react";

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
