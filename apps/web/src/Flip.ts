export type Key = string;

export type Rect = { readonly left: number; readonly top: number; readonly bottom: number };

export type Band = { readonly top: number; readonly bottom: number };

export type Move = { readonly dx: number; readonly dy: number };

export type Plan = {
  readonly enter: ReadonlyMap<Key, number>;
  readonly move: ReadonlyMap<Key, Move>;
};

const still = 0.5;

const within = (band: Band) => (rect: Rect) =>
  rect.bottom > rect.top && rect.bottom > band.top && rect.top < band.bottom;

export const flipPlan = (
  before: ReadonlyMap<Key, Rect>,
  after: ReadonlyMap<Key, Rect>,
  band: Band,
): Plan => {
  const seen = within(band);
  const enter = new Map<Key, number>();
  const move = new Map<Key, Move>();
  const shown = [...after].filter(([, rect]) => seen(rect));
  shown.sort(([, a], [, b]) => a.top - b.top || a.left - b.left);
  for (const [key, rect] of shown) {
    const was = before.get(key);
    if (was === undefined || !seen(was)) {
      enter.set(key, enter.size);
      continue;
    }
    const dx = was.left - rect.left;
    const dy = was.top - rect.top;
    if (Math.abs(dx) > still || Math.abs(dy) > still) move.set(key, { dx, dy });
  }
  return { enter, move };
};

const margin = 60;

const flags = ["data-enter", "data-flip"] as const;
const vars = ["--i", "--flip-x", "--flip-y"] as const;

const listed = ".list [data-k]:not([data-leave])";

const layout = (rows: ReadonlyArray<HTMLElement>) => ({
  root: rows[0]?.parentElement ?? null,
  rects: new Map(rows.map((row) => [row.dataset.k ?? "", row.getBoundingClientRect()])),
});

const clear = (row: HTMLElement) => {
  for (const flag of flags) row.removeAttribute(flag);
  for (const name of vars) row.style.removeProperty(name);
};

const plays = new WeakMap<HTMLElement, object>();

const settle = (row: HTMLElement) => {
  const play = {};
  plays.set(row, play);
  void Promise.allSettled(row.getAnimations().map(({ finished }) => finished)).then(() => {
    if (plays.get(row) === play) clear(row);
  });
};

type Snapshot = {
  readonly root: Element | null;
  readonly rects: ReadonlyMap<Key, Rect>;
  readonly enters: boolean;
};

let pending: Snapshot | null = null;

const play = () => {
  const was = pending;
  pending = null;
  if (was === null) return;
  const rows = [...document.querySelectorAll<HTMLElement>(listed)];
  for (const row of rows) clear(row);
  const now = layout(rows);
  const { enter, move } = flipPlan(now.root === was.root ? was.rects : new Map(), now.rects, {
    top: -margin,
    bottom: innerHeight + margin,
  });
  for (const row of rows) {
    const key = row.dataset.k ?? "";
    const index = was.enters ? enter.get(key) : undefined;
    const by = move.get(key);
    if (index !== undefined) {
      row.style.setProperty("--i", String(index));
      row.setAttribute("data-enter", "");
    } else if (by !== undefined) {
      row.style.setProperty("--flip-x", `${by.dx}px`);
      row.style.setProperty("--flip-y", `${by.dy}px`);
      row.setAttribute("data-flip", "");
    } else continue;
    settle(row);
  }
};

export const capture = (enters: boolean) => {
  if (pending !== null) return;
  pending = { ...layout([...document.querySelectorAll<HTMLElement>(listed)]), enters };
  requestAnimationFrame(play);
};

export const leave = (key: Key): Promise<void> | null => {
  const row = document.querySelector<HTMLElement>(`.list [data-k="${key}"]`);
  if (row === null || document.hidden) return null;
  const { left, right, top, bottom } = row.getBoundingClientRect();
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  if (!row.parentElement?.contains(hit)) return null;
  const { translate, opacity } = getComputedStyle(row);
  clear(row);
  row.style.setProperty("--leave-translate", translate);
  row.style.setProperty("--leave-opacity", opacity);
  row.setAttribute("data-leave", "");
  return Promise.allSettled(row.getAnimations().map(({ finished }) => finished)).then(
    () => undefined,
  );
};
