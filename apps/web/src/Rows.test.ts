import type { Row } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { face, type Intents, intentFor, neighbor, shown, tagHue } from "./Rows.ts";

const row = (id: number, last_seq: number, cleared_seq = 0): Row => ({
  id,
  source: "gmail",
  title: `#${id}`,
  tags: [],
  first_at: "2026-10-25T09:00:00.000Z",
  last_at: "2026-10-25T09:00:00.000Z",
  last_seq,
  seen_seq: last_seq,
  cleared_seq,
  muted: false,
  state: cleared_seq >= last_seq ? "done" : "read",
  new: 0,
  items: 1,
  participants: 1,
  from: { name: "Ada Lovelace", address: "ada@example.com", me: false },
  preview: "Ada: hello",
  senders: [{ name: "Ada Lovelace", address: "ada@example.com", me: false }],
});

const ids = (rows: ReadonlyArray<Row>) => rows.map(({ id }) => id);

describe("rows shown under pending intents", () => {
  it("Done hides the row from its view until something newer arrives", () => {
    const intents: Intents = new Map([[1, intentFor("untagged", row(1, 5))]]);
    expect(ids(shown("untagged", [row(1, 5), row(2, 6)], intents))).toEqual([2]);
    expect(ids(shown("tag:Work", [row(1, 5)], intents))).toEqual([]);
    expect(ids(shown("untagged", [row(1, 8)], intents))).toEqual([1]);
  });

  it("Done never hides the row from Cleared", () => {
    const intents: Intents = new Map([[1, intentFor("untagged", row(1, 5))]]);
    expect(ids(shown("cleared", [row(1, 5, 5)], intents))).toEqual([1]);
  });

  it("Restore hides the row from Cleared until it is cleared again later", () => {
    const intents: Intents = new Map([[1, intentFor("cleared", row(1, 5, 5))]]);
    expect(ids(shown("cleared", [row(1, 5, 5)], intents))).toEqual([]);
    expect(ids(shown("untagged", [row(1, 5)], intents))).toEqual([1]);
    expect(ids(shown("cleared", [row(1, 9, 9)], intents))).toEqual([1]);
  });
});

describe("next row after Done", () => {
  const rows = [row(1, 1), row(2, 2), row(3, 3)];
  it.each([
    [1, Option.some(2)],
    [2, Option.some(3)],
    [3, Option.some(2)],
    [4, Option.none()],
  ])("after %i", (id, expected) => {
    expect(Option.map(neighbor(rows, id), (next) => next.id)).toEqual(expected);
  });

  it("the only row has no next", () => {
    expect(neighbor([row(1, 1)], 1)).toEqual(Option.none());
  });
});

describe("row face", () => {
  const ada = { name: "Ada Lovelace", address: "ada@example.com", me: false };
  const bo = { name: "Bo", address: "bo@example.com", me: false };
  const nameless = { name: " ", address: "carol.k@example.com", me: false };
  const self = { name: "Sen Hung Wong", address: "sen@example.com", me: true };
  it.each([
    ["no senders, nobody else", [], 0, "", ""],
    ["no senders, three participants", [], 3, "+3", ""],
    ["one sender, alone", [ada], 1, "Ada", "Ada"],
    ["one sender of two", [ada], 2, "Ada +1", "Ada"],
    ["two senders, two participants", [ada, bo], 2, "Ada, Bo", "Ada, Bo"],
    ["two senders of five", [ada, bo], 5, "Ada, Bo +3", "Ada, Bo"],
    ["empty name uses the address local part", [nameless, bo], 2, "carol.k, Bo", "carol.k, Bo"],
    ["my own party reads Me", [self, ada], 2, "Me, Ada", "Me, Ada"],
    ["only me", [self], 1, "Me", "Me"],
  ])("%s", (_, senders, participants, who, names) => {
    expect(face({ ...row(1, 1), senders, participants })).toMatchObject({ who, names });
  });

  it("passes the daemon's sender and preview through", () => {
    const value = { ...row(1, 1), from: bo, preview: "Ship it" };
    expect(face(value)).toMatchObject({ from: bo, mark: "B", preview: "Ship it" });
  });

  it("marks the avatar Me when the daemon sends my own party", () => {
    const value = { ...row(1, 1), from: self, senders: [self] };
    expect(face(value)).toMatchObject({ from: self, mark: "Me", who: "Me" });
  });

  it("never matches Me by address", () => {
    const other = { ...self, me: false };
    expect(face({ ...row(1, 1), from: other, senders: [other] })).toMatchObject({
      mark: "S",
      who: "Sen",
    });
  });
});

describe("row tint", () => {
  const tags = ["Work", "GitHub", "Family"];
  const tagged = (...names: ReadonlyArray<string>) => ({ ...row(1, 1), tags: names });

  it("takes the hue of the tag the row is seen through", () => {
    expect(tagHue(tags, "tag:GitHub", tagged("Work", "GitHub"))).toBe(200);
  });

  it("falls back to the row's first tag outside its tag views", () => {
    expect(tagHue(tags, "cleared", tagged("Family", "Work"))).toBe(150);
    expect(tagHue(tags, "tag:Work", tagged("Family"))).toBe(150);
  });

  it("leaves untagged rows and unknown tags untinted", () => {
    expect(tagHue(tags, "untagged", tagged())).toBeUndefined();
    expect(tagHue(tags, "cleared", tagged("Gone"))).toBeUndefined();
  });
});
