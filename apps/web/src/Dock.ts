import type { Row } from "@weir/daemon/Api";

export type DockAction = "Done" | "Restore" | "MarkUnread" | "Mute";

export type Standing = { readonly state: Row["state"]; readonly read: boolean };

export const dockActions = ({ state, read }: Standing): ReadonlyArray<DockAction> => [
  state === "done" || state === "muted" ? "Restore" : "Done",
  ...(read ? (["MarkUnread"] as const) : []),
  ...(state === "muted" ? [] : (["Mute"] as const)),
];

export type Shortcut = "CloseStatus" | "Close" | "Done" | "Next" | "Previous";

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
};

export const shortcut = ({ key, modified, editing, status }: Key): Shortcut | null => {
  if (status) return key === "Escape" ? "CloseStatus" : null;
  if (modified || editing) return null;
  return Object.hasOwn(keys, key) ? (keys[key] ?? null) : null;
};
