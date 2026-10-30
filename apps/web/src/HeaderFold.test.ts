import { describe, expect, it } from "vitest";
import { fold, quieted, type Track } from "./HeaderFold.ts";

const start: Track = { y: 0, down: 0, quietUntil: 0 };

const scroll = (track: Track, folded: boolean, steps: ReadonlyArray<readonly [number, number]>) =>
  steps.reduce((state, [y, at]) => fold(state.track, state.folded, y, at), { track, folded });

describe("header fold", () => {
  it("folds once the reader has scrolled down more than 24px without turning back", () => {
    expect(
      scroll(start, false, [
        [12, 1],
        [24, 2],
      ]).folded,
    ).toBe(false);
    expect(
      scroll(start, false, [
        [12, 1],
        [25, 2],
      ]).folded,
    ).toBe(true);
  });

  it("starts counting again after any upward scroll", () => {
    const state = scroll({ ...start, y: 100 }, false, [
      [120, 2],
      [110, 3],
      [130, 4],
    ]);
    expect(state.folded).toBe(false);
    expect(scroll(state.track, state.folded, [[136, 5]]).folded).toBe(true);
  });

  it("stays folded while scrolling up and unfolds only near the top", () => {
    const folded = scroll(start, false, [[400, 1]]);
    expect(folded.folded).toBe(true);
    expect(
      scroll(folded.track, true, [
        [200, 2],
        [9, 3],
      ]).folded,
    ).toBe(true);
    expect(
      scroll(folded.track, true, [
        [200, 2],
        [8, 3],
      ]).folded,
    ).toBe(false);
  });

  it("needs a fresh 24px downward scroll to fold again after the bar reopens it", () => {
    const folded = scroll(start, false, [
      [400, 1],
      [800, 2],
    ]);
    expect(folded.folded).toBe(true);
    expect(scroll(folded.track, false, [[801, 3]]).folded).toBe(false);
    expect(
      scroll(folded.track, false, [
        [801, 3],
        [824, 4],
      ]).folded,
    ).toBe(false);
    expect(
      scroll(folded.track, false, [
        [801, 3],
        [825, 4],
      ]).folded,
    ).toBe(true);
  });

  it("ignores scrolls inside the quiet window and tracks from where they left off", () => {
    const quiet = quieted({ y: 300, down: 0, quietUntil: 0 }, 1000);
    const during = scroll(quiet, false, [
      [900, 1200],
      [0, 1500],
      [600, 1699],
    ]);
    expect(during.folded).toBe(false);
    expect(during.track.y).toBe(600);
    expect(scroll(during.track, false, [[620, 1700]]).folded).toBe(false);
    expect(scroll(during.track, false, [[625, 1700]]).folded).toBe(true);
    expect(scroll(quieted(start, 0), true, [[0, 699]]).folded).toBe(true);
  });
});
