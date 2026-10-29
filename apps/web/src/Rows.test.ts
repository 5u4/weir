import type { Row } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { type Intents, intentFor, neighbor, shown } from "./Rows.ts";

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
