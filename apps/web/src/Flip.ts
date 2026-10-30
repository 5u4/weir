import { flushSync } from "react-dom";

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

export type Part = { readonly top: number; readonly bubbles: number };

export const unfoldOrder = (parts: ReadonlyArray<Part>, bottom: number) => {
  const end = parts.findIndex(({ top }) => top >= bottom);
  return parts.slice(0, end < 0 ? parts.length : end).map(({ bubbles }, k) => ({
    g: Math.min(k, 10) + 1,
    b: Array.from({ length: bubbles }, (_, index) => index + 2),
  }));
};

export const foldOrder = (tops: ReadonlyArray<number>, bottom: number) => {
  let k = tops.filter((top) => top < bottom).length;
  return tops.map((top) => (top < bottom ? Math.min(--k, 8) : null));
};

const margin = 60;

const flags = ["data-enter", "data-flip", "data-unfold", "data-fold", "data-land"] as const;
const vars = ["--i", "--dx", "--dy", "--g"] as const;

const clear = (el: HTMLElement) => {
  for (const flag of flags) el.removeAttribute(flag);
  for (const name of vars) el.style.removeProperty(name);
};

const finished = (el: Element, subtree = false) =>
  Promise.allSettled(
    el
      .getAnimations({ subtree })
      .filter(({ effect }) => Number.isFinite(effect?.getComputedTiming().endTime))
      .map(({ finished }) => finished),
  );

const plays = new WeakMap<HTMLElement, object>();

const settle = (el: HTMLElement, subtree = false) => {
  const play = {};
  plays.set(el, play);
  void finished(el, subtree).then(() => {
    if (plays.get(el) !== play) return;
    clear(el);
    if (subtree)
      for (const inner of el.querySelectorAll<HTMLElement>("[data-k]"))
        inner.style.removeProperty("--b");
  });
};

const flag = (el: HTMLElement | undefined, name: (typeof flags)[number], values: object = {}) => {
  if (el === undefined) return;
  for (const [prop, value] of Object.entries(values)) el.style.setProperty(prop, String(value));
  el.setAttribute(name, "");
  settle(el, name === "data-unfold");
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

type Layout = {
  readonly els: ReadonlyMap<Key, HTMLElement>;
  readonly units: ReadonlyMap<Key, Unit>;
  readonly widths: ReadonlyMap<Key, number>;
};

const measure = (scope: ParentNode, seqs: boolean): Layout => {
  const els = new Map<Key, HTMLElement>();
  const units = new Map<Key, Unit>();
  const widths = new Map<Key, number>();
  for (const el of scope.querySelectorAll<HTMLElement>("[data-k]")) {
    const key = el.dataset.k ?? "";
    const { left, top, bottom, width } = el.getBoundingClientRect();
    els.set(key, el);
    widths.set(key, width);
    units.set(key, {
      left,
      top,
      bottom,
      seqs: seqs ? el.dataset.seqs?.split(" ").map(Number) : undefined,
      parent: el.parentElement?.closest<HTMLElement>("[data-k]")?.dataset.k,
    });
  }
  return { els, units, widths };
};

const reset = (scope: ParentNode) => {
  for (const el of scope.querySelectorAll<HTMLElement>("[data-k]")) clear(el);
};

const everywhere: Band = { top: Number.NEGATIVE_INFINITY, bottom: Number.POSITIVE_INFINITY };

let unfolding = false;

export const unfold = (target: Element, open: boolean, apply: () => void) => {
  if (unfolding) return;
  const topic =
    target.closest<HTMLElement>(".tp") ??
    target.closest(".dc")?.querySelector<HTMLElement>(".tp:not(.uncited)");
  const scroller = target.closest<HTMLElement>(".r-scroll");
  const article = target.closest("article");
  if (topic == null || scroller === null || article === null) return apply();
  const anchor = topic.matches(".solo:not(.uncited)")
    ? (topic.closest<HTMLElement>(".dc") ?? topic)
    : topic;
  const view = scroller.getBoundingClientRect();
  const inside = open && anchor.getBoundingClientRect().top < view.top;
  const paint = () => {
    unfolding = false;
    const was = measure(article, false);
    const top = anchor.getBoundingClientRect().top;
    reset(article);
    flushSync(apply);
    if (!anchor.isConnected) return;
    scroller.scrollTop += anchor.getBoundingClientRect().top - (inside ? view.top : top);
    if (inside) return flag(anchor, "data-land");
    const now = measure(article, false);
    for (const [key, by] of flipPlan(was.units, now.units, everywhere).move) {
      flag(now.els.get(key), "data-flip", px(by));
    }
    if (open) return;
    const parts = [...topic.querySelectorAll<HTMLElement>(":scope > .unf > *")];
    const order = unfoldOrder(
      parts.map((part) => ({
        top: part.getBoundingClientRect().top,
        bubbles: part.querySelectorAll(".bl").length,
      })),
      view.bottom,
    );
    order.forEach(({ g, b }, k) => {
      const part = parts[k];
      if (part === undefined) return;
      part.querySelectorAll<HTMLElement>(".bl").forEach((bubble, index) => {
        bubble.style.setProperty("--b", String(b[index]));
      });
      flag(part, "data-unfold", { "--g": g });
    });
  };
  const parts =
    open && !inside ? [...topic.querySelectorAll<HTMLElement>(":scope > .unf > *")] : [];
  if (parts.length === 0) return paint();
  const order = foldOrder(
    parts.map((part) => part.getBoundingClientRect().top),
    view.bottom,
  );
  parts.forEach((part, k) => {
    const i = order[k];
    if (i === null || i === undefined) return;
    part.style.setProperty("--i", String(i));
    part.setAttribute("data-fold", "");
  });
  unfolding = true;
  void Promise.all(parts.map((part) => finished(part))).then(paint);
};
