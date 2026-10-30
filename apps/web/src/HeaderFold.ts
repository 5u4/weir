export type Track = { readonly y: number; readonly down: number; readonly quietUntil: number };

const unfoldAt = 8;
const foldAfter = 24;
const quietFor = 700;

export const fold = (track: Track, folded: boolean, y: number, at: number) => {
  if (at < track.quietUntil) return { track: { ...track, y, down: 0 }, folded };
  if (y <= unfoldAt) return { track: { ...track, y, down: 0 }, folded: false };
  if (y <= track.y) return { track: { ...track, y, down: 0 }, folded };
  const down = track.down + y - track.y;
  return { track: { ...track, y, down }, folded: folded || down > foldAfter };
};

export const quieted = (track: Track, at: number): Track => ({
  ...track,
  quietUntil: at + quietFor,
});

let current: Track = { y: 0, down: 0, quietUntil: 0 };

export const quiet = () => {
  current = quieted(current, performance.now());
};

export const scrolled = (folded: boolean, y: number) => {
  const next = fold(current, folded, y, performance.now());
  current = next.track;
  return next.folded;
};

export const covered = (scope: ParentNode) => {
  const header = scope.querySelector<HTMLElement>("[data-ctx]");
  const bar = header?.querySelector<HTMLElement>(":scope > button");
  if (header == null || bar == null) return 0;
  return header.closest("[data-folded]") === null
    ? header.offsetHeight
    : bar.offsetTop + bar.offsetHeight;
};
