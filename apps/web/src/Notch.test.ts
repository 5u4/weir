import type { Counts } from "@weir/daemon/Api";
import { describe, expect, it } from "vitest";
import { type Clause, monogram, sentence, type Widget } from "./Notch.ts";

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
