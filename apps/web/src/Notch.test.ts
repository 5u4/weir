import type { Counts } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import type { Alert } from "./Health.ts";
import {
  type AlertClause,
  alertClause,
  type Clause,
  formOf,
  monogram,
  notchKey,
  sentence,
  type Widget,
} from "./Notch.ts";

const view = (unread: number, open = unread) => ({ unread, open, senders: [] });

const counts = (
  tags: ReadonlyArray<readonly [string, number, number?]>,
  untagged: readonly [number, number?],
  cleared = 0,
): Counts => ({
  unread: 0,
  tags: tags.map(([name, unread, open]) => ({ name, ...view(unread, open) })),
  untagged: view(...untagged),
  cleared,
});

const widgetText = ({ kind, name, count }: Widget) => {
  if (kind === "clear") return name;
  if (kind === "cleared") return `${name} ${count}`;
  return `${count} ${name}`;
};

const clauseText = (clause: Clause) =>
  clause.map(({ lead, widget, end }) => `${lead}${widgetText(widget)}${end}`).join(" ");

const read = (value: Counts) => {
  const { main, tail } = sentence(value);
  return {
    main: main._tag === "CaughtUp" ? "All caught up." : clauseText(main.clause),
    tail: tail.map(clauseText).join(" "),
  };
};

describe("notch sentence", () => {
  it.each([
    ["one tag", counts([["Work", 13]], [0]), "13 Work has updates."],
    ["two tags", counts([["Work", 13]], [12]), "13 Work and 12 Untagged have updates."],
    [
      "three or more, no comma before and, Untagged last",
      counts(
        [
          ["Work", 15],
          ["Lists", 12],
          ["GitHub", 8],
        ],
        [31],
      ),
      "15 Work, 12 Lists, 8 GitHub and 31 Untagged have updates.",
    ],
    ["no tags in config", counts([], [4]), "4 Untagged has updates."],
    ["everything read", counts([["Work", 0, 3]], [0, 2]), "All caught up."],
    ["nothing at all", counts([], [0]), "All caught up."],
  ])("%s", (_, value, expected) => {
    expect(read(value).main).toBe(expected);
  });

  it.each([
    ["only Cleared when every view has updates", counts([["Work", 2]], [1], 0), "Cleared 0."],
    [
      "read but not done, then clear tags, then Cleared",
      counts(
        [
          ["Me", 0, 2],
          ["On-call", 0, 0],
          ["GitHub", 1, 4],
          ["Promos", 0, 0],
        ],
        [0, 6],
        7,
      ),
      "Read but not done: 2 Me and 6 Untagged. On-call and Promos are clear. Cleared 7.",
    ],
    ["one clear tag", counts([["On-call", 0]], [3], 1), "On-call is clear. Cleared 1."],
    ["empty Untagged is never called clear", counts([], [0]), "Cleared 0."],
  ])("tail: %s", (_, value, expected) => {
    expect(read(value).tail).toBe(expected);
  });

  it("an updates widget links to its view and carries its senders", () => {
    const senders = [
      { name: "Ada Lovelace", address: "ada@example.com" },
      { name: "", address: "noreply@github.com" },
    ];
    const { main } = sentence({
      unread: 3,
      tags: [{ name: "GitHub", unread: 3, open: 4, senders }],
      untagged: view(0),
      cleared: 0,
    });
    expect(main._tag === "Updates" && main.clause[0]?.widget).toEqual({
      kind: "updates",
      view: "tag:GitHub",
      name: "GitHub",
      count: 3,
      senders,
    });
  });
});

describe("notch key", () => {
  const shown = counts([["Work", 3]], [2], 1);
  it.each([
    ["full", true],
    ["compact", true],
    ["search", false],
    ["result", false],
  ] as const)("%s: a count change ticks only where counts show (%s)", (form, ticks) => {
    const after = counts([["Work", 2]], [2], 2);
    expect(notchKey(form, Option.some(shown)) !== notchKey(form, Option.some(after))).toBe(ticks);
  });

  it("a refetch with the same numbers keeps the key", () => {
    expect(notchKey("full", Option.some(shown))).toBe(
      notchKey("full", Option.some(counts([["Work", 3]], [2], 1))),
    );
  });

  it("the sentence and the pill are different notches for the same counts", () => {
    expect(notchKey("full", Option.some(shown))).not.toBe(notchKey("compact", Option.some(shown)));
  });
});

describe("notch form", () => {
  it.each([
    ["list", { settings: false, reading: false, query: "", searching: false }, "full"],
    ["search opened", { settings: false, reading: false, query: "", searching: true }, "search"],
    [
      "search from the URL",
      { settings: false, reading: false, query: "a", searching: false },
      "search",
    ],
    ["reading", { settings: false, reading: true, query: "", searching: false }, "compact"],
    [
      "reading a result",
      { settings: false, reading: true, query: "a", searching: false },
      "result",
    ],
    ["Settings", { settings: true, reading: true, query: "a", searching: true }, "compact"],
  ] as const)("%s", (_, shown, form) => {
    expect(formOf(shown)).toBe(form);
  });
});

describe("alert clause", () => {
  const current = DateTime.makeUnsafe("2026-10-25T16:00:00.000Z");
  const hoursBefore = (hours: number) => DateTime.subtract(current, { hours });
  it.each<[string, Alert, AlertClause]>([
    [
      "a failed source says when it last synced",
      { _tag: "SourcesFailed", sources: [{ id: "gmail", since: hoursBefore(2) }] },
      {
        text: "gmail stopped syncing 2h ago.",
        short: "gmail stopped",
        focus: { section: "sources", source: "gmail" },
      },
    ],
    [
      "a source that never synced says so",
      { _tag: "SourcesFailed", sources: [{ id: "gmail", since: null }] },
      {
        text: "gmail never synced.",
        short: "gmail stopped",
        focus: { section: "sources", source: "gmail" },
      },
    ],
    [
      "several sources share one clause timed from the oldest, aimed at the first",
      {
        _tag: "SourcesFailed",
        sources: [
          { id: "gmail", since: hoursBefore(2) },
          { id: "slack", since: hoursBefore(5) },
          { id: "work", since: null },
        ],
      },
      {
        text: "gmail, slack and work stopped syncing 5h ago.",
        short: "3 sources stopped",
        focus: { section: "sources", source: "gmail" },
      },
    ],
    [
      "a config error points at Config",
      {
        _tag: "ConfigStopped",
        error: { file: "/h/config.toml", message: "invalid config", issues: [] },
      },
      { text: "Sync stopped: config error.", short: "Sync stopped", focus: { section: "config" } },
    ],
  ])("%s", (_, alert, clause) => {
    expect(alertClause(alert, current)).toEqual(clause);
  });
});

describe("sender initials", () => {
  it.each([
    [{ name: "Ada Lovelace", address: "ada@example.com" }, "A"],
    [{ name: "", address: "noreply@github.com" }, "N"],
    [{ name: '"Jacky" Ng', address: "j@x.io" }, "J"],
    [{ name: "王小明", address: "w@x.cn" }, "王"],
  ])("%j -> %s", (sender, expected) => {
    expect(monogram(sender)).toBe(expected);
  });
});
