import { describe, expect, it } from "vitest";
import {
  type DockAction,
  dockActions,
  type Key,
  type Shortcut,
  type Standing,
  shortcut,
} from "./Dock.ts";

describe("dock actions for the open conversation", () => {
  it.each<[string, Standing, ReadonlyArray<DockAction>]>([
    ["unread", { state: "unread", read: false }, ["Done", "Mute"]],
    ["read", { state: "read", read: true }, ["Done", "MarkUnread", "Mute"]],
    [
      "unread, just read to the end",
      { state: "unread", read: true },
      ["Done", "MarkUnread", "Mute"],
    ],
    ["read, then marked unread", { state: "read", read: false }, ["Done", "Mute"]],
    ["done and read", { state: "done", read: true }, ["Restore", "MarkUnread", "Mute"]],
    ["done with unread messages", { state: "done", read: false }, ["Restore", "Mute"]],
    ["muted and read", { state: "muted", read: true }, ["Restore", "MarkUnread"]],
    ["muted with unread messages", { state: "muted", read: false }, ["Restore"]],
  ])("%s", (_, standing, expected) => {
    expect(dockActions(standing)).toEqual(expected);
  });
});

describe("keyboard shortcuts", () => {
  const key = (overrides: Partial<Key>): Key => ({
    key: "e",
    modified: false,
    editing: false,
    settings: false,
    ...overrides,
  });
  it.each<[string, Key, Shortcut | null]>([
    ["e is Done", key({}), "Done"],
    ["j moves down", key({ key: "j" }), "Next"],
    ["k moves up", key({ key: "k" }), "Previous"],
    ["Esc closes the conversation", key({ key: "Escape" }), "Close"],
    ["only a lowercase e", key({ key: "E" }), null],
    ["other keys do nothing", key({ key: "x" }), null],
    ["a key named like an object property", key({ key: "constructor" }), null],
    ["typing e in a field", key({ editing: true }), null],
    ["typing j in a field", key({ key: "j", editing: true }), null],
    ["Esc in a field", key({ key: "Escape", editing: true }), null],
    ["a modifier with e", key({ modified: true }), null],
    ["a modifier with j", key({ key: "j", modified: true }), null],
    ["Esc closes Settings first", key({ key: "Escape", settings: true }), "CloseSettings"],
    [
      "Esc closes Settings from a field",
      key({ key: "Escape", settings: true, editing: true }),
      "CloseSettings",
    ],
    ["e under Settings", key({ settings: true }), null],
    ["j under Settings", key({ key: "j", settings: true }), null],
    ["/ opens search", key({ key: "/" }), "Search"],
    ["/ opens search from Settings", key({ key: "/", settings: true }), "Search"],
    ["typing / in a field", key({ key: "/", editing: true }), null],
    ["typing / in a field under Settings", key({ key: "/", editing: true, settings: true }), null],
    ["a modifier with /", key({ key: "/", modified: true }), null],
    [", opens Settings", key({ key: "," }), "Settings"],
    [", closes Settings", key({ key: ",", settings: true }), "Settings"],
    ["typing , in a field", key({ key: ",", editing: true }), null],
    ["a modifier with ,", key({ key: ",", modified: true }), null],
  ])("%s", (_, pressed, expected) => {
    expect(shortcut(pressed)).toBe(expected);
  });
});
