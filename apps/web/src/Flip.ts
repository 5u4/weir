import { flushSync } from "react-dom";
import { covered, quiet } from "./HeaderFold.ts";

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
  const reach = band.bottom - band.top;
  const was = new Map([...before].filter(([, unit]) => seen(unit)));
  const shown = [...after].filter(([, unit]) => seen(unit));
  shown.sort(([, a], [, b]) => a.top - b.top || a.left - b.left);
  const holders = new Set([...after.values()].map(({ parent }) => parent));
  const from = new Map<Key, Move>();
  const order = new Map<Key, number>();
  for (const [key, unit] of shown) {
    const prior = before.get(key);
    const same =
      was.get(key) ??
      (prior !== undefined && prior.bottom > prior.top && Math.abs(prior.top - unit.top) < reach
        ? prior
        : undefined);
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

const flags = [
  "data-enter",
  "data-flip",
  "data-born",
  "data-merge",
  "data-unfold",
  "data-fold",
  "data-land",
  "data-resume",
] as const;
const vars = ["--i", "--dx", "--dy", "--g", "--was-opacity"] as const;

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

let unfolding = false;

const folding = (el: Element) => unfolding && el.closest("[data-fold]") !== null;

const flag = (el: HTMLElement | undefined, name: (typeof flags)[number], values: object = {}) => {
  if (el === undefined || folding(el)) return;
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

type Pose = { readonly opacity: string; readonly translate: string };

const posed = (el: Element): Pose => {
  const { opacity, translate } = getComputedStyle(el);
  return { opacity, translate };
};

const poses = (scope: Element) => {
  const seen = new Map<Element, Pose>();
  for (const animation of scope.getAnimations({ subtree: true })) {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (animation instanceof CSSAnimation && target instanceof HTMLElement && target !== scope)
      seen.set(target, posed(target));
  }
  return seen;
};

const pin = (el: HTMLElement, { opacity, translate }: Pose, moved: boolean) => {
  el.style.setProperty("--was-opacity", opacity);
  if (moved) el.style.setProperty("--was-translate", translate);
  el.setAttribute("data-held", "");
};

const entering = (part: Element) =>
  part.getAnimations({ subtree: true }).flatMap((animation) => {
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    return animation instanceof CSSAnimation &&
      animation.animationName === "unfold-in" &&
      target instanceof HTMLElement
      ? [target]
      : [];
  });

const reset = (scope: Element) => {
  const was = poses(scope);
  for (const el of scope.querySelectorAll<HTMLElement>("[data-k], [data-resume]"))
    if (!folding(el)) clear(el);
  for (const [el, { opacity }] of was) {
    if (!(el instanceof HTMLElement) || el.getAnimations().length > 0) continue;
    if (Number(opacity) < Number(getComputedStyle(el).opacity))
      flag(el, "data-resume", { "--was-opacity": opacity });
  }
};

const everywhere: Band = { top: Number.NEGATIVE_INFINITY, bottom: Number.POSITIVE_INFINITY };

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
  const ceiling = view.top + covered(article);
  const inside = open && anchor.getBoundingClientRect().top < ceiling;
  const paint = () => {
    unfolding = false;
    if (!topic.isConnected) return apply();
    const was = measure(article, false);
    const top = anchor.getBoundingClientRect().top;
    reset(article);
    flushSync(apply);
    if (!anchor.isConnected) return;
    quiet();
    scroller.scrollTop += anchor.getBoundingClientRect().top - (inside ? ceiling : top);
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
  const held = parts.flatMap(entering).map((el) => [el, posed(el)] as const);
  for (const part of parts) part.removeAttribute("data-unfold");
  for (const [el, pose] of held) pin(el, pose, true);
  parts.forEach((part, k) => {
    const i = order[k];
    if (i === null || i === undefined) return;
    plays.delete(part);
    part.style.setProperty("--i", String(i));
    part.setAttribute("data-fold", "");
  });
  unfolding = true;
  void Promise.all(parts.map((part) => finished(part))).then(paint);
};

export type Before = {
  readonly article: HTMLElement;
  readonly layout: Layout;
  readonly poses: ReadonlyMap<Element, Pose>;
};

const look = (article: Element | null): Before | null =>
  article instanceof HTMLElement
    ? { article, layout: measure(article, true), poses: poses(article) }
    : null;

const copied = [
  ...flags,
  "data-k",
  "data-seqs",
  "data-key",
  "data-hit",
  "data-current",
  "data-gap",
] as const;

const ghostOf = (source: HTMLElement, seen: ReadonlyMap<Element, Pose>) => {
  const copy = source.cloneNode(true);
  if (!(copy instanceof HTMLElement)) return null;
  const sources = [source, ...source.querySelectorAll("*")];
  [copy, ...copy.querySelectorAll("*")].forEach((el, index) => {
    for (const name of copied) el.removeAttribute(name);
    const from = sources[index];
    const pose = from === undefined ? undefined : seen.get(from);
    if (pose !== undefined && el instanceof HTMLElement) pin(el, pose, el !== copy);
  });
  const ghost = document.createElement("div");
  ghost.append(copy);
  return ghost;
};

const land = ({ article, layout: was, poses: seen }: Before, restore: () => void) => {
  if (!article.isConnected) return;
  const scroller = article.closest(".r-scroll");
  const layer = article.querySelector<HTMLElement>(":scope > [data-ghosts]");
  if (scroller === null || layer === null) return;
  flushSync(() => undefined);
  quiet();
  restore();
  reset(article);
  layer.replaceChildren();
  const now = measure(article, true);
  const view = scroller.getBoundingClientRect();
  const plan = flipPlan(was.units, now.units, {
    top: view.top - margin,
    bottom: view.bottom + margin,
  });
  for (const [key, by] of plan.move) flag(now.els.get(key), "data-flip", px(by));
  for (const [key, i] of plan.enter)
    flag(now.els.get(key), "data-born", { "--i": Math.min(i, 10) });
  for (const [key, { i, ...by }] of plan.merge) {
    flag(now.els.get(key), "data-merge", { ...px(by), "--i": Math.min(i, 10) });
  }
  const origin = article.getBoundingClientRect();
  layer.style.setProperty("--view-top", `${view.top - origin.top}px`);
  layer.style.setProperty("--view-h", `${view.height}px`);
  for (const [key, to] of plan.ghost) {
    const source = was.els.get(key);
    const unit = was.units.get(key);
    const ghost = source === undefined ? null : ghostOf(source, seen);
    if (ghost === null || unit === undefined) continue;
    ghost.style.setProperty("--x", `${unit.left - origin.left}px`);
    ghost.style.setProperty("--y", `${unit.top - view.top}px`);
    ghost.style.setProperty("--w", `${was.widths.get(key) ?? 0}px`);
    if (to !== null)
      for (const [prop, value] of Object.entries(px(to))) ghost.style.setProperty(prop, value);
    ghost.setAttribute("data-ghost", to === null ? "fade" : "travel");
    layer.append(ghost);
    void finished(ghost).then(() => ghost.remove());
  }
};

const unchanged = ({ article, layout }: Before) => {
  const keys = [...article.querySelectorAll<HTMLElement>("[data-k]")].map(
    ({ dataset }) => dataset.k ?? "",
  );
  const kept = [...layout.units.keys()];
  return keys.length === kept.length && keys.every((key, index) => key === kept[index]);
};

type Armed = { readonly keep: () => () => void; was: Before; restore: () => void };

let armed: Armed | null = null;

const retake = () => {
  if (armed === null || !unchanged(armed.was)) return;
  const was = look(armed.was.article);
  if (was === null) return;
  armed.was = was;
  armed.restore = armed.keep();
};

const scrollerOf = (handle: Armed | null) => handle?.was.article.closest(".r-scroll");

export const before = (article: Element | null, keep: Armed["keep"] = () => () => undefined) => {
  quiet();
  scrollerOf(armed)?.removeEventListener("scroll", retake);
  const was = look(article);
  armed = was === null ? null : { keep, was, restore: keep() };
  scrollerOf(armed)?.addEventListener("scroll", retake, { passive: true });
  return armed;
};

export const after = (handle: Armed | null) => {
  if (handle === null) return;
  if (armed === handle) {
    scrollerOf(armed)?.removeEventListener("scroll", retake);
    armed = null;
  }
  land(handle.was, handle.restore);
};

export const reshape = (target: Element, apply: () => void) => {
  const handle = before(target.closest("article"));
  flushSync(apply);
  after(handle);
};

let following: Before | null = null;

export const follow = (article: Element | null) => {
  if (following !== null || armed?.was.article.isConnected === true) return;
  following = look(article);
  if (following === null) return;
  requestAnimationFrame(() => {
    const was = following;
    following = null;
    if (was === null || armed?.was.article.isConnected === true || unchanged(was)) return;
    land(was, () => undefined);
  });
};
