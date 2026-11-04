import type { Counts } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { type Alert, ago } from "./Health.ts";
import type { SettingsFocus, View } from "./Route.ts";

export type Sender = Counts["untagged"]["senders"][number];

export type WidgetKind = "updates" | "quiet" | "clear" | "cleared";

export type Widget = {
  readonly kind: WidgetKind;
  readonly view: View;
  readonly name: string;
  readonly count: number;
  readonly senders: ReadonlyArray<Sender>;
};

export type Group<W = Widget> = { readonly lead: string; readonly widget: W; readonly end: string };
export type Clause = ReadonlyArray<Group>;

export type Sentence = {
  readonly main:
    | { readonly _tag: "CaughtUp" }
    | { readonly _tag: "Updates"; readonly clause: Clause };
  readonly tail: ReadonlyArray<Clause>;
  readonly planned: Counts["planned"];
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

export const enumerate = <W>(
  widgets: ReadonlyArray<W>,
  lead: string,
  end: string,
): ReadonlyArray<Group<W>> =>
  widgets.map((item, at) => {
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
    planned: counts.planned,
  };
};

export const overdue = (planned: Counts["planned"], today: string) =>
  planned.dues.filter((due) => due < today).length;

export type AlertClause = {
  readonly text: string;
  readonly short: string;
  readonly focus: SettingsFocus;
};

export const alertClause = (alert: Alert, current: DateTime.Utc): AlertClause => {
  if (alert._tag === "ConfigStopped") {
    return {
      text: "Sync stopped: config error.",
      short: "Sync stopped",
      focus: { section: "config" },
    };
  }
  const names = enumerate(
    alert.sources.map(({ id }) => id),
    "",
    "",
  )
    .map(({ lead, widget, end }) => `${lead}${widget}${end}`)
    .join(" ");
  const oldest = alert.sources.reduce<DateTime.Utc | null>(
    (found, { since }) =>
      since === null || (found !== null && DateTime.isGreaterThan(since, found)) ? found : since,
    null,
  );
  return {
    text: `${names} ${oldest === null ? "never synced" : `stopped syncing ${ago(oldest, current)}`}.`,
    short:
      alert.sources.length === 1 ? `${names} stopped` : `${alert.sources.length} sources stopped`,
    focus: { section: "sources", source: alert.sources[0].id },
  };
};

export type CapForm = "full" | "compact" | "search" | "result";

export const formOf = ({
  settings,
  reading,
  query,
  searching,
  planning,
}: {
  readonly settings: boolean;
  readonly reading: boolean;
  readonly query: string;
  readonly searching: boolean;
  readonly planning: boolean;
}): CapForm =>
  settings
    ? "compact"
    : reading
      ? query === ""
        ? "compact"
        : "result"
      : searching || query !== ""
        ? "search"
        : planning
          ? "compact"
          : "full";

const notchShape: Record<CapForm, (counts: Counts) => unknown> = {
  full: sentence,
  compact: (counts) => [chips(counts), clearedWidget(counts)],
  search: () => null,
  result: () => null,
};

export const notchKey = (form: CapForm, counts: Option.Option<Counts>) =>
  JSON.stringify([form, Option.getOrNull(Option.map(counts, notchShape[form]))]);

export const widgetDescription = ({ kind }: Widget) => {
  switch (kind) {
    case "updates":
      return "with updates";
    case "quiet":
      return "read but not done";
    case "clear":
      return "is clear";
    case "cleared":
      return undefined;
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
