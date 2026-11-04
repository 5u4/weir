import type { Row } from "@weir/daemon/Api";
import type { Mode } from "./Route.ts";

export type DockAction = "Done" | "Plan" | "Restore" | "MarkUnread" | "Mute";

export type Standing = {
  readonly state: Row["state"];
  readonly read: boolean;
  readonly eventOnly: boolean;
};

export const dockActions = ({ state, read, eventOnly }: Standing): ReadonlyArray<DockAction> => [
  state === "done" || state === "muted" ? "Restore" : "Done",
  ...(state === "muted" || eventOnly ? [] : (["Plan"] as const)),
  ...(state === "planned" ? (["Restore"] as const) : []),
  ...(read ? (["MarkUnread"] as const) : []),
  ...(state === "muted" ? [] : (["Mute"] as const)),
];

export type Shortcut =
  | "CloseSettings"
  | "Close"
  | "Day"
  | "Done"
  | "Later"
  | "Month"
  | "Next"
  | "Plan"
  | "PlanMode"
  | "Previous"
  | "Search"
  | "Settings"
  | "Sooner"
  | "Today";

export type Key = {
  readonly key: string;
  readonly modified: boolean;
  readonly editing: boolean;
  readonly settings: boolean;
  readonly mode: Mode;
};

const shared: Readonly<Record<string, Shortcut>> = {
  Escape: "Close",
  e: "Done",
  g: "PlanMode",
  j: "Next",
  k: "Previous",
  p: "Plan",
  "/": "Search",
  ",": "Settings",
};

const keys: Readonly<Record<Mode, Readonly<Record<string, Shortcut>>>> = {
  messages: shared,
  plan: {
    ...shared,
    r: "Plan",
    d: "Day",
    m: "Month",
    t: "Today",
    ArrowLeft: "Sooner",
    ArrowRight: "Later",
  },
};

export const shortcut = ({ key, modified, editing, settings, mode }: Key): Shortcut | null => {
  if (settings && key === "Escape") return "CloseSettings";
  if (modified || editing || (settings && key !== "/" && key !== ",")) return null;
  const table = keys[mode];
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
};
