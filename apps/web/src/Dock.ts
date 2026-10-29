import type { Row } from "@weir/daemon/Api";

export type DockAction = "Done" | "Restore" | "MarkUnread" | "Mute";

export type Standing = { readonly state: Row["state"]; readonly read: boolean };

export const dockActions = ({ state, read }: Standing): ReadonlyArray<DockAction> => [
  state === "done" || state === "muted" ? "Restore" : "Done",
  ...(read ? (["MarkUnread"] as const) : []),
  ...(state === "muted" ? [] : (["Mute"] as const)),
];

export type Shortcut = "CloseStatus" | "Close" | "Done" | "Next" | "Previous" | "Search";

export type Key = {
  readonly key: string;
  readonly modified: boolean;
  readonly editing: boolean;
  readonly status: boolean;
};

const keys: Readonly<Record<string, Shortcut>> = {
  Escape: "Close",
  e: "Done",
  j: "Next",
  k: "Previous",
  "/": "Search",
};

export const shortcut = ({ key, modified, editing, status }: Key): Shortcut | null => {
  if (status && key === "Escape") return "CloseStatus";
  if (modified || editing || (status && key !== "/")) return null;
  return Object.hasOwn(keys, key) ? (keys[key] ?? null) : null;
};
