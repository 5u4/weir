import { afterEach, describe, expect, it, vi } from "vitest";
import { type Band, capture, flipPlan, type Rect } from "./Flip.ts";

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
  getAnimations = () => (this.attributes.size > 0 ? [{ finished: new Promise(() => {}) }] : []);
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
      vars: { "--i": "0", "--flip-x": "0px", "--flip-y": "-100px" },
    });
    expect(seen("8")).toEqual({
      attributes: ["data-enter", "data-flip"],
      vars: { "--i": "1", "--flip-x": "0px", "--flip-y": "-100px" },
    });
    expect(seen("9")).toEqual({ attributes: ["data-enter"], vars: { "--i": "0" } });
    expect(seen("6")).toEqual({
      attributes: ["data-flip"],
      vars: { "--flip-x": "0px", "--flip-y": "-100px" },
    });
  });
});
