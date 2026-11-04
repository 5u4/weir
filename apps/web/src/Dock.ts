import type { Row } from "@weir/daemon/Api";

export type DockAction = "Done" | "Restore" | "MarkUnread" | "Mute";

export type Standing = { readonly state: Row["state"]; readonly read: boolean };

export const dockActions = ({ state, read }: Standing): ReadonlyArray<DockAction> => [
  state === "done" || state === "muted" ? "Restore" : "Done",
  ...(read ? (["MarkUnread"] as const) : []),
  ...(state === "muted" ? [] : (["Mute"] as const)),
];

export type Shortcut =
  | "CloseSettings"
  | "Close"
  | "Done"
  | "Next"
  | "Previous"
  | "Search"
  | "Settings";

export type Key = {
  readonly key: string;
  readonly modified: boolean;
  readonly editing: boolean;
  readonly settings: boolean;
};

const keys: Readonly<Record<string, Shortcut>> = {
  Escape: "Close",
  e: "Done",
  j: "Next",
  k: "Previous",
  "/": "Search",
  ",": "Settings",
};

export const shortcut = ({ key, modified, editing, settings }: Key): Shortcut | null => {
  if (settings && key === "Escape") return "CloseSettings";
  if (modified || editing || (settings && key !== "/" && key !== ",")) return null;
  return Object.hasOwn(keys, key) ? (keys[key] ?? null) : null;
};
