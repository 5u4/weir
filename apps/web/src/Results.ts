import type { SearchResult } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import type { Sender } from "./Notch.ts";
import { type View, viewLabel } from "./Route.ts";

export type Result = SearchResult["conversations"][number];

export type ResultGroup = {
  readonly view: View;
  readonly name: string;
  readonly count: number;
  readonly senders: ReadonlyArray<Sender>;
};

export const cleared = (result: Pick<Result, "state">) =>
  result.state === "done" || result.state === "muted";

export const inGroup = (result: Pick<Result, "state" | "tags">, view: View) => {
  if (view === "cleared") return cleared(result);
  if (cleared(result)) return false;
  return view === "untagged"
    ? result.tags.length === 0
    : result.tags.includes(view.slice("tag:".length));
};

const sendersOf = (results: ReadonlyArray<Result>) => {
  const seen = new Map<string, Sender>();
  for (const { from } of results) {
    if (!from.me && !seen.has(from.address)) seen.set(from.address, from);
  }
  return [...seen.values()].slice(0, 3);
};

export const groups = (
  results: ReadonlyArray<Result>,
  tags: ReadonlyArray<string>,
): ReadonlyArray<ResultGroup> =>
  [...tags.map((tag): View => `tag:${tag}`), "untagged" as const, "cleared" as const].flatMap(
    (view) => {
      const members = results.filter((result) => inGroup(result, view));
      return members.length === 0
        ? []
        : [{ view, name: viewLabel(view), count: members.length, senders: sendersOf(members) }];
    },
  );

export const picked = (
  results: ReadonlyArray<Result>,
  tags: ReadonlyArray<string>,
  choice: Option.Option<View>,
) => Option.filter(choice, (view) => groups(results, tags).some((group) => group.view === view));

export const narrowed = (results: ReadonlyArray<Result>, group: Option.Option<View>) =>
  Option.match(group, {
    onNone: () => results,
    onSome: (view) => results.filter((result) => inGroup(result, view)),
  });

export const fieldLabels: Readonly<Record<Result["hits"][number]["field"], string>> = {
  topic: "Digest",
  body: "Message",
  from: "Sender",
  source: "Source",
  headline: "Headline",
};
