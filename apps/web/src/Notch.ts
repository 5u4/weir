import type { Counts } from "@weir/daemon/Api";
import type { View } from "./Route.ts";

export type Sender = Counts["untagged"]["senders"][number];

export type WidgetKind = "updates" | "quiet" | "clear" | "cleared";

export type Widget = {
  readonly kind: WidgetKind;
  readonly view: View;
  readonly name: string;
  readonly count: number;
  readonly senders: ReadonlyArray<Sender>;
};

export type Group = { readonly lead: string; readonly widget: Widget; readonly end: string };
export type Clause = ReadonlyArray<Group>;

export type Sentence = {
  readonly main:
    | { readonly _tag: "CaughtUp" }
    | { readonly _tag: "Updates"; readonly clause: Clause };
  readonly tail: ReadonlyArray<Clause>;
};

type Summary = {
  readonly view: View;
  readonly name: string;
  readonly unread: number;
  readonly open: number;
  readonly senders: ReadonlyArray<Sender>;
};

const summaries = (counts: Counts): ReadonlyArray<Summary> => [
  ...counts.tags.map(({ name, ...rest }): Summary => ({ view: `tag:${name}`, name, ...rest })),
  { view: "untagged", name: "Untagged", ...counts.untagged },
];

const widget =
  (kind: WidgetKind) =>
  (summary: Summary): Widget => ({
    kind,
    view: summary.view,
    name: summary.name,
    count: kind === "updates" ? summary.unread : summary.open,
    senders: kind === "updates" ? summary.senders : [],
  });

const enumerate = (widgets: ReadonlyArray<Widget>, lead: string, end: string): Clause =>
  widgets.map((item, at): Group => {
    const last = at === widgets.length - 1;
    return {
      lead: `${at === 0 ? lead : ""}${last && widgets.length > 1 ? "and " : ""}`,
      widget: item,
      end: last ? end : at < widgets.length - 2 ? "," : "",
    };
  });

const kindOf = (summary: { readonly unread: number; readonly open: number }) =>
  summary.unread > 0 ? "updates" : summary.open > 0 ? "quiet" : "clear";

export const chips = (counts: Counts): ReadonlyArray<Widget> =>
  summaries(counts).map((summary) => widget(kindOf(summary))(summary));

export const clearedWidget = (counts: Counts): Widget => ({
  kind: "cleared",
  view: "cleared",
  name: "Cleared",
  count: counts.cleared,
  senders: [],
});

export const sentence = (counts: Counts): Sentence => {
  const all = summaries(counts);
  const hot = all.filter((summary) => kindOf(summary) === "updates");
  const quiet = all.filter((summary) => kindOf(summary) === "quiet");
  const clear = all.filter((summary) => kindOf(summary) === "clear" && summary.view !== "untagged");
  return {
    main:
      hot.length === 0
        ? { _tag: "CaughtUp" }
        : {
            _tag: "Updates",
            clause: enumerate(
              hot.map(widget("updates")),
              "",
              ` ${hot.length === 1 ? "has" : "have"} updates.`,
            ),
          },
    tail: [
      ...(quiet.length > 0
        ? [enumerate(quiet.map(widget("quiet")), "Read but not done: ", ".")]
        : []),
      ...(clear.length > 0
        ? [
            enumerate(
              clear.map(widget("clear")),
              "",
              ` ${clear.length === 1 ? "is" : "are"} clear.`,
            ),
          ]
        : []),
      enumerate([clearedWidget(counts)], "", "."),
    ],
  };
};

export const widgetLabel = ({ kind, name, count }: Widget) => {
  switch (kind) {
    case "updates":
      return `${count} ${name} with updates`;
    case "quiet":
      return `${count} ${name} read but not done`;
    case "clear":
      return `${name} is clear`;
    case "cleared":
      return `${count} cleared`;
  }
};

export const monogram = ({ name, address }: Sender) => {
  const source = (name.trim() === "" ? (address.split("@")[0] ?? "") : name).replace(
    /^[^\p{L}\p{N}]+/u,
    "",
  );
  const first = [...source][0] ?? "?";
  return first.toLocaleUpperCase("en");
};

export const hue = (address: string) => {
  let hash = 2166136261;
  for (const char of address.toLowerCase()) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  }
  return (hash >>> 0) % 360;
};
