import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Band,
  capture,
  flipPlan,
  foldOrder,
  type Rect,
  type Unit,
  unfoldOrder,
} from "./Flip.ts";

const band: Band = { top: -60, bottom: 860 };

const at = (top: number, left = 0): Rect => ({ left, top, bottom: top + 100 });

const rects = (entries: ReadonlyArray<readonly [string, Rect]>) => new Map(entries);

describe("flipPlan", () => {
  it.each([
    {
      name: "a reply moves a row to the top and pushes the rest down one row",
      before: rects([
        ["11", at(0)],
        ["6", at(100)],
        ["2", at(200)],
      ]),
      after: rects([
        ["2", at(0)],
        ["11", at(100)],
        ["6", at(200)],
      ]),
      enter: [],
      move: [
        ["2", { dx: 0, dy: 200 }],
        ["11", { dx: 0, dy: -100 }],
        ["6", { dx: 0, dy: -100 }],
      ],
    },
    {
      name: "new ids enter in visual order, whatever order the map lists them in",
      before: rects([["6", at(0)]]),
      after: rects([
        ["9", at(200)],
        ["6", at(300)],
        ["8", at(100)],
        ["7", at(0)],
      ]),
      enter: [
        ["7", 0],
        ["8", 1],
        ["9", 2],
      ],
      move: [["6", { dx: 0, dy: -300 }]],
    },
    {
      name: "moves at or under half a pixel are skipped",
      before: rects([
        ["1", at(0)],
        ["2", at(100.5)],
        ["3", at(200, 0.6)],
      ]),
      after: rects([
        ["1", at(0.5)],
        ["2", at(100)],
        ["3", at(200)],
      ]),
      enter: [],
      move: [["3", { dx: 0.6, dy: 0 }]],
    },
    {
      name: "rows outside the viewport and its 60px margin neither enter nor move",
      before: rects([
        ["1", at(-500)],
        ["2", at(900)],
      ]),
      after: rects([
        ["1", at(1000)],
        ["2", at(1100)],
        ["3", at(-161)],
        ["4", at(861)],
      ]),
      enter: [],
      move: [],
    },
    {
      name: "a row that was out of band and slides into view enters",
      before: rects([["1", at(-200)]]),
      after: rects([["1", at(0)]]),
      enter: [["1", 0]],
      move: [],
    },
    {
      name: "a remounted row is matched by its key, so selection alone plays nothing",
      before: rects([
        ["5", at(0)],
        ["4", at(100)],
      ]),
      after: rects([
        ["5", at(0)],
        ["4", at(100)],
      ]),
      enter: [],
      move: [],
    },
    {
      name: "rows with no height are skipped",
      before: rects([]),
      after: rects([["1", { left: 0, top: 0, bottom: 0 }]]),
      enter: [],
      move: [],
    },
  ])("$name", ({ before, after, enter, move }) => {
    const plan = flipPlan(before, after, band);
    expect([...plan.enter]).toEqual(enter);
    expect([...plan.move]).toEqual(move);
  });
});

describe("flipPlan for nested blocks and digest landings", () => {
  const unit = (top: number, extra: Partial<Unit> = {}, left = 0): Unit => ({
    left,
    top,
    bottom: top + 50,
    ...extra,
  });

  it("a block inside a moved block moves only by the difference", () => {
    const plan = flipPlan(
      new Map([
        ["card", unit(100)],
        ["topic", unit(150, { parent: "card" })],
        ["below", unit(200, { parent: "card" })],
      ]),
      new Map([
        ["card", unit(300)],
        ["topic", unit(350, { parent: "card" })],
        ["below", unit(500, { parent: "card" })],
      ]),
      band,
    );
    expect([...plan.move]).toEqual([
      ["card", { dx: 0, dy: -200 }],
      ["below", { dx: 0, dy: -100 }],
    ]);
  });

  it("a new topic travels from the corner of the bubbles it cites, and the bubbles travel to it", () => {
    const plan = flipPlan(
      new Map([
        ["g-1", unit(400)],
        ["b-1", unit(420, { seqs: [1], parent: "g-1" }, 30)],
        ["b-2", unit(470, { seqs: [2], parent: "g-1" }, 30)],
        ["b-3", unit(520, { seqs: [3] }, 30)],
      ]),
      new Map([
        ["d-9", unit(100)],
        ["h-9", unit(110, { parent: "d-9" })],
        ["tp-9:0", unit(200, { seqs: [1, 2], parent: "d-9" }, 40)],
        ["tp-9:1", unit(260, { seqs: [3], parent: "d-9" }, 40)],
      ]),
      band,
    );
    expect([...plan.enter]).toEqual([["h-9", 0]]);
    expect([...plan.merge]).toEqual([
      ["tp-9:0", { dx: -10, dy: 220, i: 1 }],
      ["tp-9:1", { dx: -10, dy: 260, i: 2 }],
    ]);
    expect([...plan.ghost]).toEqual([
      ["g-1", { dx: 40, dy: -200 }],
      ["b-3", { dx: 10, dy: -260 }],
    ]);
  });

  it("a block that stays keeps its key even when bubbles around it leave", () => {
    const plan = flipPlan(
      new Map([
        ["tp-1:0", unit(100, { seqs: [1, 2] })],
        ["b-1", unit(150, { seqs: [1], parent: "tp-1:0" })],
        ["Skeleton", unit(300)],
      ]),
      new Map([
        ["tp-1:0", unit(100, { seqs: [1, 2] })],
        ["b-1", unit(150, { seqs: [1], parent: "tp-1:0" })],
      ]),
      band,
    );
    expect([...plan.move]).toEqual([]);
    expect([...plan.merge]).toEqual([]);
    expect([...plan.ghost]).toEqual([["Skeleton", null]]);
  });

  it("a block that only scrolled out of view is no ghost", () => {
    const plan = flipPlan(
      new Map([["b-4", unit(100, { seqs: [4] })]]),
      new Map([["b-4", unit(2000, { seqs: [4] })]]),
      band,
    );
    expect([...plan.ghost]).toEqual([]);
  });
});

describe("stagger order", () => {
  it("numbers unfolding groups from 1, caps at 11 and stops at the viewport bottom", () => {
    const parts = Array.from({ length: 14 }, (_, k) => ({ top: k * 10, bubbles: k === 0 ? 3 : 1 }));
    const order = unfoldOrder(parts, 125);
    expect(order.map(({ g }) => g)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 11]);
    expect(order[0]?.b).toEqual([2, 3, 4]);
  });

  it("folds visible groups last-first, caps at 8 and leaves the rest alone", () => {
    expect(foldOrder([0, 10, 20, 900], 500)).toEqual([2, 1, 0, null]);
    expect(
      foldOrder(
        Array.from({ length: 11 }, (_, k) => k),
        500,
      ),
    ).toEqual([8, 8, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });
});

class Row {
  readonly dataset: { k: string };
  readonly parentElement: object;
  readonly attributes = new Set<string>();
  readonly vars = new Map<string, string>();
  readonly style = {
    setProperty: (name: string, value: string) => void this.vars.set(name, value),
    removeProperty: (name: string) => void this.vars.delete(name),
  };
  top = 0;

  constructor(key: string, parentElement: object) {
    this.dataset = { k: key };
    this.parentElement = parentElement;
  }

  getBoundingClientRect = (): Rect => ({ left: 0, top: this.top, bottom: this.top + 100 });
  getAnimations = () =>
    this.attributes.size > 0
      ? [{ effect: { getComputedTiming: () => ({ endTime: 1 }) }, finished: new Promise(() => {}) }]
      : [];
  hasAttribute = (name: string) => this.attributes.has(name);
  setAttribute = (name: string) => void this.attributes.add(name);
  removeAttribute = (name: string) => void this.attributes.delete(name);
}

describe("a list update while rows are still rising in", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the rise running and slides the rows to their new places", () => {
    const list = {};
    const rows = new Map<string, Row>();
    let shown: Row[] = [];
    const show = (keys: ReadonlyArray<string>) => {
      shown = keys.map((key, index) => {
        const row = rows.get(key) ?? new Row(key, list);
        rows.set(key, row);
        row.top = index * 100;
        return row;
      });
    };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("document", { querySelectorAll: () => shown });
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    const update = (keys: ReadonlyArray<string>) => {
      capture(true);
      show(keys);
      for (const frame of frames.splice(0)) frame(0);
    };

    show(["6"]);
    update(["7", "8", "6"]);
    update(["9", "7", "8", "6"]);

    const seen = (key: string) => {
      const row = rows.get(key);
      return {
        attributes: [...(row?.attributes ?? [])].sort(),
        vars: Object.fromEntries(row?.vars ?? []),
      };
    };
    expect(seen("7")).toEqual({
      attributes: ["data-enter", "data-flip"],
      vars: { "--i": "0", "--dx": "0px", "--dy": "-100px" },
    });
    expect(seen("8")).toEqual({
      attributes: ["data-enter", "data-flip"],
      vars: { "--i": "1", "--dx": "0px", "--dy": "-100px" },
    });
    expect(seen("9")).toEqual({ attributes: ["data-enter"], vars: { "--i": "0" } });
    expect(seen("6")).toEqual({
      attributes: ["data-flip"],
      vars: { "--dx": "0px", "--dy": "-100px" },
    });
  });
});
