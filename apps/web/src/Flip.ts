export type Key = string;

export type Rect = { readonly left: number; readonly top: number; readonly bottom: number };

export type Unit = Rect & {
  readonly seqs?: ReadonlyArray<number> | undefined;
  readonly parent?: Key | undefined;
};

export type Band = { readonly top: number; readonly bottom: number };

export type Move = { readonly dx: number; readonly dy: number };

export type Plan = {
  readonly enter: ReadonlyMap<Key, number>;
  readonly move: ReadonlyMap<Key, Move>;
  readonly merge: ReadonlyMap<Key, Move & { readonly i: number }>;
  readonly ghost: ReadonlyMap<Key, Move | null>;
};

const still = 0.5;

const within = (band: Band) => (rect: Rect) =>
  rect.bottom > rect.top && rect.bottom > band.top && rect.top < band.bottom;

const offset = (from: Rect, to: Rect): Move => ({ dx: from.left - to.left, dy: from.top - to.top });

const corner = (rects: ReadonlyArray<Rect>): Rect => ({
  left: Math.min(...rects.map(({ left }) => left)),
  top: Math.min(...rects.map(({ top }) => top)),
  bottom: Math.max(...rects.map(({ bottom }) => bottom)),
});

const sharing = (seqs: ReadonlySet<number>) => (unit: Unit) =>
  unit.seqs?.some((seq) => seqs.has(seq)) === true;

const carried = (units: ReadonlyMap<Key, Unit>) => {
  const bags = new Map<Key, Set<number>>();
  for (const [key, unit] of units) {
    for (let at: Key | undefined = key; at !== undefined; at = units.get(at)?.parent) {
      const bag = bags.get(at) ?? new Set<number>();
      for (const seq of unit.seqs ?? []) bag.add(seq);
      bags.set(at, bag);
    }
  }
  return bags;
};

export const flipPlan = (
  before: ReadonlyMap<Key, Unit>,
  after: ReadonlyMap<Key, Unit>,
  band: Band,
): Plan => {
  const seen = within(band);
  const was = new Map([...before].filter(([, unit]) => seen(unit)));
  const shown = [...after].filter(([, unit]) => seen(unit));
  shown.sort(([, a], [, b]) => a.top - b.top || a.left - b.left);
  const holders = new Set([...after.values()].map(({ parent }) => parent));
  const from = new Map<Key, Move>();
  const order = new Map<Key, number>();
  for (const [key, unit] of shown) {
    const same = was.get(key);
    if (same !== undefined) {
      from.set(key, offset(same, unit));
      continue;
    }
    const sources =
      unit.seqs === undefined ? [] : [...was.values()].filter(sharing(new Set(unit.seqs)));
    if (sources.length > 0) from.set(key, offset(corner(sources), unit));
    else if (holders.has(key)) continue;
    order.set(key, order.size);
  }
  const enter = new Map<Key, number>();
  const move = new Map<Key, Move>();
  const merge = new Map<Key, Move & { readonly i: number }>();
  for (const [key, unit] of shown) {
    const by = from.get(key);
    const index = order.get(key);
    if (by === undefined) {
      if (index !== undefined) enter.set(key, index);
      continue;
    }
    const base = unit.parent === undefined ? undefined : from.get(unit.parent);
    const rel = base === undefined ? by : { dx: by.dx - base.dx, dy: by.dy - base.dy };
    if (index !== undefined) merge.set(key, { ...rel, i: index });
    else if (Math.abs(rel.dx) > still || Math.abs(rel.dy) > still) move.set(key, rel);
  }
  const bags = carried(before);
  const landed = shown.map(([, unit]) => unit);
  const ghost = new Map<Key, Move | null>();
  for (const [key, unit] of was) {
    if (after.has(key)) continue;
    if (unit.parent !== undefined && was.has(unit.parent) && !after.has(unit.parent)) continue;
    const bag = bags.get(key);
    const to = bag === undefined || bag.size === 0 ? [] : landed.filter(sharing(bag));
    ghost.set(key, to.length === 0 ? null : offset(corner(to), unit));
  }
  return { enter, move, merge, ghost };
};

const margin = 60;

const flags = ["data-enter", "data-flip"] as const;
const vars = ["--i", "--dx", "--dy"] as const;

const clear = (el: HTMLElement) => {
  for (const flag of flags) el.removeAttribute(flag);
  for (const name of vars) el.style.removeProperty(name);
};

const finished = (el: Element) =>
  Promise.allSettled(
    el
      .getAnimations()
      .filter(({ effect }) => Number.isFinite(effect?.getComputedTiming().endTime))
      .map(({ finished }) => finished),
  );

const plays = new WeakMap<HTMLElement, object>();

const settle = (el: HTMLElement) => {
  const play = {};
  plays.set(el, play);
  void finished(el).then(() => {
    if (plays.get(el) === play) clear(el);
  });
};

const flag = (el: HTMLElement | undefined, name: (typeof flags)[number], values: object = {}) => {
  if (el === undefined) return;
  for (const [prop, value] of Object.entries(values)) el.style.setProperty(prop, String(value));
  el.setAttribute(name, "");
  settle(el);
};

const px = ({ dx, dy }: Move) => ({ "--dx": `${dx}px`, "--dy": `${dy}px` });

type Snapshot = {
  readonly root: Element | null;
  readonly rects: ReadonlyMap<Key, Rect>;
  readonly enters: boolean;
};

const listed = ".list [data-k]:not([data-leave])";

const layout = (rows: ReadonlyArray<HTMLElement>) => ({
  root: rows[0]?.parentElement ?? null,
  rects: new Map(rows.map((row) => [row.dataset.k ?? "", row.getBoundingClientRect()])),
});

const unslide = (row: HTMLElement) => {
  row.removeAttribute("data-flip");
  row.style.removeProperty("--dx");
  row.style.removeProperty("--dy");
};
let pending: Snapshot | null = null;

const play = () => {
  const was = pending;
  pending = null;
  if (was === null) return;
  const rows = [...document.querySelectorAll<HTMLElement>(listed)];
  const rising = new Set(rows.filter((row) => row.hasAttribute("data-enter")));
  for (const row of rows) (rising.has(row) ? unslide : clear)(row);
  const now = layout(rows);
  const { enter, move } = flipPlan(now.root === was.root ? was.rects : new Map(), now.rects, {
    top: -margin,
    bottom: innerHeight + margin,
  });
  for (const row of rows) {
    const key = row.dataset.k ?? "";
    const index = was.enters && !rising.has(row) ? enter.get(key) : undefined;
    const by = move.get(key);
    if (index !== undefined) flag(row, "data-enter", { "--i": index });
    else if (by !== undefined) flag(row, "data-flip", px(by));
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
  return finished(row).then(() => undefined);
};

export const stay = (key: Key) => {
  const row = document.querySelector<HTMLElement>(`.list [data-k="${key}"]`);
  if (row === null || !row.hasAttribute("data-leave")) return;
  row.removeAttribute("data-leave");
  row.style.removeProperty("--leave-translate");
  row.style.removeProperty("--leave-opacity");
  flag(row, "data-enter", { "--i": 0 });
};
