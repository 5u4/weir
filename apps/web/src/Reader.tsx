import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import { hast, type Root } from "@weir/daemon/Markdown";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type UIEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import { Avatar } from "./Avatar.tsx";
import {
  type Block,
  type Bubbles,
  type Detail,
  type Digest,
  type Fold,
  type ItemSummary,
  participants,
  type ReaderUi,
  reader,
  revealing,
  span,
  type TopicKey,
  type TopicView,
  type UncitedKey,
} from "./Blocks.ts";
import {
  type Action,
  earlierLabel,
  failedAt,
  type Here,
  hereLabel,
  type Range,
  type Run,
  reason,
  runs,
  within,
} from "./Digest.ts";
import type { DockAction } from "./Dock.ts";
import { after, before, reshape, unfold } from "./Flip.ts";
import { covered, quiet, scrolled } from "./HeaderFold.ts";
import { clockTime, dayAndTime, dayLabel, now, plural } from "./Health.ts";
import { type Hit, hitKey, matches } from "./Hits.ts";
import { Highlighted, Prose, proseClass } from "./Marked.tsx";
import { monogram } from "./Notch.ts";
import {
  dock,
  following,
  headerFold,
  hitAt,
  landing,
  type Preview,
  pins,
  preview,
  readerUi,
  reading,
  searchHits,
} from "./Reading.ts";
import { fieldLabels } from "./Results.ts";
import { type ConversationId, route } from "./Route.ts";
import { homeTag, tagHue } from "./Rows.ts";
import { conversation, digestRun, dismiss, runDigest, searchPattern, tagOrder } from "./Weir.ts";

type Controls = {
  readonly run: Run;
  readonly act: (action: Action, range: Range, items: number, anchor?: Element | null) => void;
};

type Failed = Extract<Run, { readonly _tag: "Failed" }>;

type Tint = "tag" | "ink";

const tintClass: Record<Tint, string> = { tag: "bg-tag", ink: "bg-ink" };

const separatorClass =
  "not-first:before:mx-em-0.6 not-first:before:text-ink-4 not-first:before:content-dot";

const iconClass = "fill-none stroke-current linecap-round linejoin-round";

const hitClass = "outline-hit outline-solid outline-ink";

const fadeClass = "opacity-faded transition-opacity duration-base";

const bleedClass = "-mx-bleed -mt-1.5 rounded-3xl px-bleed py-1.5";

const pinClass =
  "pin sticky top-0 z-pin bg-pin backdrop-blur-lg backdrop-saturate-pin in-data-folded:top-14";

const lineClass = "flex min-h-8 items-center gap-3 text-xs text-ink-3 tabular-nums";

const lineKeyClass = "flex-none font-bold";

const chipClass =
  "ml-auto inline-flex h-7 flex-none items-center gap-1.5 rounded-full pr-3 text-xs font-bold text-ink-2 shadow-ring-line transition-ink-ring-press duration-fast enabled:hover:text-ink enabled:hover:shadow-ring-ink-3 active:scale-press disabled:cursor-default";

const pillClass =
  "mt-0.5 h-7 flex-none rounded-full px-3 text-xs leading-7 font-semibold active:scale-press";

const foldClass =
  "mt-3 flex min-h-11 w-full items-center rounded-xl bg-hover text-left transition-bg duration-fast hover:bg-line-2";

const previewing = (set: (preview: Preview) => void, range: Range) => ({
  onPointerEnter: (event: PointerEvent) => {
    if (event.pointerType !== "touch") set({ _tag: "Hover", range });
  },
  onPointerLeave: (event: PointerEvent) => {
    if (event.pointerType !== "touch") set(null);
  },
  onFocus: () => set({ _tag: "Hover", range }),
  onBlur: () => set(null),
});

function Arrow({ up = false }: { up?: boolean }) {
  return (
    <svg
      className={`size-3.5 flex-none stroke-1.7 ${iconClass}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d={up ? "M8 12.5v-9M4.5 7L8 3.5 11.5 7" : "M8 3.5v9M4.5 9L8 12.5 11.5 9"} />
    </svg>
  );
}

function LogPath({ failed, block = false }: { failed: Failed; block?: boolean }) {
  return failed.cause._tag === "Failed" && failed.cause.log_path !== null ? (
    <span className={`min-w-0 basis-full wrap-anywhere text-ink-3 ${block ? "block" : ""}`}>
      Raw output{" "}
      <code className="font-mono text-xs leading-normal text-ink-2 normal-nums">
        {failed.cause.log_path}
      </code>
    </span>
  ) : null;
}

function Failure({
  failed,
  controls,
  className,
  gap,
  k,
}: {
  failed: Failed;
  controls: Controls;
  className: string;
  gap?: number;
  k?: string;
}) {
  const why = reason(failed.cause);
  return (
    <div
      className={`${lineClass} flex-wrap gap-y-0.5 ${className}`}
      role="alert"
      data-gap={gap}
      data-k={k}
    >
      <span className={`${lineKeyClass} text-warn`}>
        Couldn't digest {plural(failed.items, "message")}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink-2" title={why}>
        {why}
      </span>
      <button
        type="button"
        className={`${chipClass} pl-3 disabled:opacity-half`}
        onClick={(event) =>
          controls.act(
            failed.action,
            failed.range,
            failed.items,
            event.currentTarget.closest("[data-gap]"),
          )
        }
      >
        Try again
      </button>
      <LogPath failed={failed} />
    </div>
  );
}

const shimmerClass = "block rounded-md bg-shimmer animate-shimmer motion-reduce:animate-none";
const barClass = `mt-2.5 h-3 w-bar ${shimmerClass}`;
const headBarClass = `mt-2.5 h-5.5 w-bar ${shimmerClass}`;
const titleBarClass = `mt-0.5 h-3.75 w-bar ${shimmerClass}`;

function Skeleton({ items, tint, lead }: { items: number; tint: Tint; lead: boolean }) {
  const bar = (width: string, className = barClass) => (
    <span className={className} style={{ "--w": width } as CSSProperties} />
  );
  const topic = (title: string, line: string, short: string) => (
    <div className="mt-5.5 grid grid-cols-topic">
      <span className={`mt-1 h-3 w-11.5 ${shimmerClass}`} />
      <div>
        {bar(title, titleBarClass)}
        {bar(line)}
        {bar(short)}
      </div>
    </div>
  );
  return (
    <div
      className={`relative pt-1 pb-2 ${lead ? "mt-2" : "mt-10"}`}
      role="status"
      aria-live="polite"
      data-k="Skeleton"
    >
      <p className="m-0 mb-1 flex items-center gap-2 text-xs font-semibold text-ink-2">
        <span
          className={`size-1.75 rounded-circle animate-beat motion-reduce:animate-none ${tintClass[tint]}`}
          aria-hidden="true"
        />
        Digesting {plural(items, "message")}…
      </p>
      <div aria-hidden="true">
        {bar("64%", headBarClass)}
        {topic("30%", "92%", "58%")}
        {topic("24%", "84%", "40%")}
      </div>
    </div>
  );
}

const scrollKeys: Record<string, true> = {
  ArrowDown: true,
  ArrowUp: true,
  PageDown: true,
  PageUp: true,
  Home: true,
  End: true,
  " ": true,
};

const day = (iso: string) =>
  DateTime.formatLocal(DateTime.makeUnsafe(iso), { month: "short", day: "numeric" });

const timeSpan = (items: ReadonlyArray<ItemSummary>) => {
  const covered = span(items);
  if (covered === null) return "";
  const { first, last } = covered;
  const from = DateTime.makeUnsafe(first);
  const to = DateTime.makeUnsafe(last);
  if (first === last) return dayAndTime(from);
  return day(first) === day(last)
    ? `${day(first)} ${clockTime(from)}–${clockTime(to)}`
    : `${dayAndTime(from)} – ${dayAndTime(to)}`;
};

const stateNames: Record<TopicView["topic"]["state"], string> = {
  open: "Open",
  resolved: "Resolved",
  fyi: "FYI",
};

const stateClass: Record<TopicView["topic"]["state"], string> = {
  open: "text-ink before:shadow-ring-thick-ink",
  resolved: "text-ink-3 before:bg-ink-4",
  fyi: "text-ink-3 before:shadow-ring-ink-4",
};

function Chevron({ up = false, flip = false }: { up?: boolean; flip?: boolean }) {
  return (
    <svg
      className={`size-3.5 flex-none stroke-1.8 transition-transform duration-spring motion-reduce:transition-none ${iconClass} ${flip ? "rotate-flip" : ""}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
    </svg>
  );
}

type Watch = (end: HTMLElement) => () => void;

type Mark = { readonly seen: number; readonly unread: (from: number) => void };

type Found = {
  readonly pattern: RegExp | null;
  readonly hits: ReadonlyMap<string, Hit>;
  readonly current: string | null;
};

const hitProps = (found: Found, key: string) =>
  found.hits.has(key)
    ? { "data-hit": key, "data-current": found.current === key ? "" : undefined }
    : {};

function End({ seq, watch }: { seq: number; watch: Watch }) {
  return (
    <span
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0"
      data-seq={seq}
      ref={watch}
      aria-hidden="true"
    />
  );
}

function DayLine({ at }: { at: string }) {
  return (
    <div
      className="mt-5 mb-1.5 flex justify-center"
      role="separator"
      data-k={blockKey({ _tag: "Day", at })}
    >
      <span className="rounded-full bg-hover px-2.5 py-0.5 text-xs font-semibold text-ink-3 tabular-nums">
        {dayLabel(DateTime.makeUnsafe(at), useAtomValue(now))}
      </span>
    </div>
  );
}

function Long({
  id,
  seq,
  tree,
  pattern,
  me,
  className,
}: {
  id: ConversationId;
  seq: number;
  tree: Root;
  pattern: RegExp | null;
  me: boolean;
  className: string;
}) {
  const [ui, setUi] = useAtom(readerUi(id));
  const [over, setOver] = useState(false);
  const measure = useCallback(
    (body: HTMLDivElement) => {
      const overflows = () =>
        body.scrollHeight >
        Number.parseFloat(getComputedStyle(body).getPropertyValue("--clip")) + 2;
      const observer = new ResizeObserver(() => setOver(overflows()));
      observer.observe(body);
      const reveal = (event: FocusEvent) => {
        if (body.hasAttribute("data-open") || !overflows()) return;
        setUi((current) => ({ ...current, long: new Set(current.long).add(seq) }));
        const target = event.target;
        if (target instanceof HTMLElement) {
          requestAnimationFrame(() => {
            quiet();
            target.scrollIntoView({ block: "center" });
          });
        }
      };
      body.addEventListener("focusin", reveal);
      return () => {
        observer.disconnect();
        body.removeEventListener("focusin", reveal);
      };
    },
    [seq, setUi],
  );
  const open = ui.long.has(seq);
  return (
    <>
      <div
        className={className}
        data-clip
        data-open={open || undefined}
        data-over={over || undefined}
        ref={measure}
      >
        <Prose tree={tree} pattern={pattern} />
      </div>
      <button
        type="button"
        className={`mt-1.5 h-6.5 rounded-full px-3 text-xs font-semibold transition-ink-ring duration-fast ${over ? "inline-flex items-center" : "hidden"} ${me ? "text-me-ink shadow-ring-glass" : "text-ink-2 shadow-ring-line hover:text-ink hover:shadow-ring-ink-3"}`}
        aria-expanded={open}
        onClick={(event) => {
          const bubble = event.currentTarget.closest(".bl");
          setUi((current) => {
            const long = new Set(current.long);
            if (open) long.delete(seq);
            else long.add(seq);
            return { ...current, long };
          });
          if (open) {
            requestAnimationFrame(() => {
              quiet();
              bubble?.scrollIntoView({
                block: "nearest",
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
                  ? "auto"
                  : "smooth",
              });
            });
          }
        }}
      >
        {open ? "Show less" : "Show all"}
      </button>
    </>
  );
}

const hoverChipClass = (shown: boolean) =>
  `relative inline-flex h-7 items-center gap-1.5 rounded-full bg-island pr-3 pl-2.5 text-xs font-semibold whitespace-nowrap text-ink elevation-float transition-reveal direction-ltr before:absolute before:-inset-0.75 active:scale-press ${shown ? "pointer-events-auto translate-none opacity-full" : "translate-y-lift opacity-none group-focus-within:pointer-events-auto group-focus-within:translate-none group-focus-within:opacity-full group-hover:pointer-events-auto group-hover:translate-none group-hover:opacity-full motion-reduce:translate-none"}`;

const bubbleFillClass = ({
  me,
  folded,
  previewed,
  tint,
}: {
  me: boolean;
  folded: boolean;
  previewed: boolean;
  tint: Tint;
}) => {
  if (me) {
    if (previewed) return tint === "tag" ? "bg-preview-me-tag" : "bg-preview-me";
    return folded ? "bg-me-fold" : "bg-me-bg";
  }
  if (previewed) return tint === "tag" ? "bg-preview-tag" : "bg-preview";
  return folded ? "bg-transparent shadow-ring-line" : "bg-bubble";
};

function Bubble({
  id,
  item,
  here,
  controls,
  watch,
  mark,
  found,
  me,
  folded,
  tint,
}: {
  id: ConversationId;
  item: ItemSummary;
  here: Here | undefined;
  controls: Controls | null;
  watch: Watch | undefined;
  mark: Mark;
  found: Found;
  me: boolean;
  folded: boolean;
  tint: Tint;
}) {
  const key = hitKey({ _tag: "Item", seq: item.seq });
  const tree = hast(item.body_new);
  const hit = found.hits.get(key);
  const [shown, setPreview] = useAtom(preview);
  const run = controls?.run;
  const action: Action = { _tag: "From", seq: item.seq };
  const digestible = here !== undefined && controls !== null;
  const failed = digestible && run !== undefined ? failedAt(run, action) : undefined;
  const tapped = shown?._tag === "Tap" && shown.seq === item.seq;
  const previewed =
    digestible && shown !== null && shown.range !== null && within(shown.range, item.seq);
  const classes = [
    "bl group relative flex min-w-0 max-w-lane",
    digestible &&
      `before:absolute before:-inset-y-0.5 before:w-0.5 before:rounded-xs before:transition-opacity before:duration-fast ${me ? "before:-right-1.5" : "before:-left-1.5"} ${tint === "tag" ? "before:bg-tag" : "before:bg-ink"} ${previewed ? "before:opacity-full" : "before:opacity-none"}`,
    digestible && run?._tag === "Running" && within(run.range, item.seq) && fadeClass,
  ];
  const foldedClass = me ? "text-md leading-relaxed" : "text-md leading-relaxed text-ink-2";
  return (
    <>
      <div
        className={classes.filter(Boolean).join(" ")}
        data-k={`b-${item.seq}`}
        data-seqs={item.seq}
        {...hitProps(found, key)}
        onClick={(event) => {
          if (!(digestible || item.seq <= mark.seen)) return;
          if (!(event.nativeEvent instanceof globalThis.PointerEvent)) return;
          if (event.nativeEvent.pointerType !== "touch") return;
          if (event.target instanceof Element && event.target.closest("button, a") !== null) return;
          setPreview(
            tapped ? null : { _tag: "Tap", seq: item.seq, range: digestible ? here.range : null },
          );
        }}
      >
        <div
          className={`min-w-0 max-w-em-36 rounded-b-2xl px-3.5 py-2.5 text-base leading-relaxed wrap-anywhere transition-bg duration-fast ${me ? "rounded-tl-2xl rounded-tr-md text-me-ink" : "rounded-tl-md rounded-tr-2xl text-ink"} ${bubbleFillClass({ me, folded, previewed, tint })} ${found.current === key ? `${hitClass} outline-offset-out` : ""}`}
        >
          {tree.children.length === 0 ? (
            <p className={`m-0 ${folded ? foldedClass : "text-ink-3"}`}>(no text)</p>
          ) : (
            <Long
              id={id}
              seq={item.seq}
              tree={tree}
              pattern={found.pattern}
              me={me}
              className={folded ? `${proseClass} ${foldedClass}` : proseClass}
            />
          )}
        </div>
        {hit?._tag === "Item" && hit.field !== "body" && (
          <span
            className="ml-2 inline-flex flex-none items-center gap-1.5 self-center text-2xs leading-5 font-semibold whitespace-nowrap text-ink-3 before:size-2 before:rounded-xs before:bg-mk"
            title={`Matched in ${fieldLabels[hit.field]}`}
          >
            {fieldLabels[hit.field]}
          </span>
        )}
        {(digestible || item.seq <= mark.seen) && (
          <span
            className={`pointer-events-none absolute inset-x-0 bottom-overlap z-raised flex flex-wrap justify-end-safe gap-1.5 px-2.5 ${me ? "direction-rtl" : ""}`}
          >
            {item.seq <= mark.seen && (
              <button
                type="button"
                className={`${hoverChipClass(tapped)} hover:bg-hover`}
                onClick={() => mark.unread(item.seq)}
              >
                Mark unread from here
              </button>
            )}
            {digestible && (
              <button
                type="button"
                className={`${hoverChipClass(tapped || runs(controls.run, action))} enabled:hover:bg-hover disabled:cursor-default disabled:text-ink-3`}
                disabled={controls.run._tag === "Running"}
                onClick={() => controls.act(action, here.range, here.items)}
                {...previewing(setPreview, here.range)}
              >
                <Arrow />
                {runs(controls.run, action) ? "Digesting…" : hereLabel(here.items)}
              </button>
            )}
          </span>
        )}
        {watch !== undefined && <End seq={item.seq} watch={watch} />}
      </div>
      {failed !== undefined && controls !== null && (
        <Failure
          failed={failed}
          controls={controls}
          className={`mt-0.5 mb-1.5 max-w-lane ${me ? "self-end" : ""}`}
        />
      )}
    </>
  );
}

function Group({
  id,
  group,
  mark,
  found,
  tint,
  watch,
  controls = null,
  folded = false,
}: {
  id: ConversationId;
  group: Bubbles;
  mark: Mark;
  found: Found;
  tint: Tint;
  watch?: Watch;
  controls?: Controls | null;
  folded?: boolean;
}) {
  const name = group.me ? "Me" : group.from.name.trim() || group.from.address;
  const at = DateTime.makeUnsafe(group.at);
  const avatar = (
    <span className="pt-5 text-av-md">
      <Avatar address={group.from.address} mark={group.me ? "Me" : monogram(group.from)} />
    </span>
  );
  const column = (
    <div className={`flex min-w-0 flex-col gap-0.5 ${group.me ? "items-end" : "items-start"}`}>
      <div className="g-head flex max-w-full items-baseline gap-2 px-3.5 text-xs leading-4.5 whitespace-nowrap text-ink-3 tabular-nums">
        <b
          className="overflow-hidden font-bold text-ellipsis text-ink-2"
          title={group.from.address}
        >
          {name}
        </b>
        <time dateTime={group.at} title={dayAndTime(at)}>
          {clockTime(at)}
        </time>
      </div>
      {group.items.map((item, index) => (
        <Bubble
          key={item.seq}
          id={id}
          item={item}
          here={group.heres?.[index]}
          controls={controls}
          watch={watch}
          mark={mark}
          found={found}
          me={group.me}
          folded={folded}
          tint={tint}
        />
      ))}
    </div>
  );
  return (
    <section
      className={`sg grid gap-x-2.5 gap-y-0 ${folded ? "mt-2.5" : "mt-3"} ${group.me ? "grid-cols-group-me" : "grid-cols-group"}`}
      aria-label={`${name}, ${dayAndTime(at)}`}
      data-k={blockKey(group)}
    >
      {group.me ? column : avatar}
      {group.me ? avatar : column}
    </section>
  );
}

function Pin({
  id,
  fold,
  view,
}: {
  id: ConversationId;
  fold: (target: Element) => void;
  view: TopicView;
}) {
  const at = useAtomValue(pins(id)).get(view.key) ?? 1;
  return (
    <span className="ml-auto inline-flex items-center gap-2.5 self-center">
      <span className="text-xs whitespace-nowrap text-ink-3 tabular-nums" aria-live="off">
        {Math.min(at, view.items.length)} of {view.items.length}
      </span>
      <button
        type="button"
        className="inline-flex h-6.5 items-center gap-1 rounded-full pr-2 pl-2.5 text-xs font-semibold text-ink-2 shadow-ring-line hover:text-ink hover:shadow-ring-ink-3"
        onClick={(event) => fold(event.currentTarget)}
        aria-label="Fold the originals back"
      >
        Fold
        <Chevron up />
      </button>
    </span>
  );
}

type AnyFold = Fold<TopicKey | UncitedKey>;

const flipped =
  ({ key, open }: AnyFold) =>
  (ui: ReaderUi): ReaderUi => {
    const originals = new Set(ui.originals);
    if (open) originals.delete(key);
    else originals.add(key);
    return { ...ui, originals };
  };

function Originals({
  id,
  fold,
  noun,
  toggle,
  mark,
  found,
  tint,
  solo,
}: {
  id: ConversationId;
  fold: AnyFold;
  noun: string;
  toggle: (target: Element) => void;
  mark: Mark;
  found: Found;
  tint: Tint;
  solo: boolean;
}) {
  const who = [...new Map(fold.items.map((item) => [item.from_me || item.from.address, item]))];
  const cellClass = solo ? "col-start-1" : "col-start-2";
  return (
    <>
      <button
        type="button"
        className={`${cellClass} mt-1.5 -ml-1.5 inline-flex h-7.5 items-center gap-1.5 justify-self-start rounded-full pr-2 pl-1.5 text-xs font-semibold tabular-nums transition-tint duration-fast hover:bg-hover hover:text-ink ${fold.open ? "text-ink" : "text-ink-3"}`}
        aria-expanded={fold.open}
        onClick={(event) => toggle(event.currentTarget)}
      >
        <span className="mr-0.5 inline-flex text-av-sm" aria-hidden="true">
          {who.slice(0, 3).map(([key, item], index) => (
            <Avatar
              key={String(key)}
              address={item.from.address}
              mark={item.from_me ? "Me" : monogram(item.from)}
              className={index > 0 ? "-ml-1.5 shadow-halo-island" : "shadow-halo-island"}
            />
          ))}
        </span>
        {plural(fold.items.length, noun)}
        <Chevron flip={fold.open} />
      </button>
      {fold.open && (
        <div className={`unf ${cellClass} mt-1 mb-1.5`}>
          {fold.groups.map((group) =>
            group._tag === "Day" ? (
              <DayLine key={blockKey(group)} at={group.at} />
            ) : (
              <Group
                key={blockKey(group)}
                id={id}
                group={group}
                mark={mark}
                found={found}
                tint={tint}
                folded
              />
            ),
          )}
        </div>
      )}
    </>
  );
}

const titleClass =
  "m-0 font-display text-lg leading-normal font-semibold tracking-snug text-balance break-keep wrap-anywhere text-ink palt";

function Topic({
  id,
  view,
  solo,
  mark,
  found,
  tint,
}: {
  id: ConversationId;
  view: TopicView;
  solo: boolean;
  mark: Mark;
  found: Found;
  tint: Tint;
}) {
  const [, setUi] = useAtom(readerUi(id));
  const toggle = (target: Element) => unfold(target, view.open, () => setUi(flipped(view)));
  const key = hitKey({ _tag: "Topic", key: view.key });
  return (
    <section
      className={`tp relative grid items-start ${solo ? "solo grid-cols-1" : "grid-cols-topic"}`}
      data-k={`tp-${view.key}`}
      data-seqs={view.items.map(({ seq }) => seq).join(" ")}
      {...hitProps(found, key)}
    >
      {!solo ? (
        <header
          className={`col-span-full grid grid-cols-topic-head items-baseline ${bleedClass} ${view.open ? pinClass : ""}`}
          data-key={view.key}
        >
          <i
            className={`inline-block font-sans text-2xs leading-5 font-bold whitespace-nowrap not-italic before:mr-1.5 before:inline-block before:size-1.75 before:rounded-circle before:align-px ${stateClass[view.topic.state]}`}
          >
            {stateNames[view.topic.state]}
          </i>
          <h4 className={titleClass}>
            <Highlighted text={view.topic.title} pattern={found.pattern} />
          </h4>
          {view.open && <Pin id={id} fold={toggle} view={view} />}
        </header>
      ) : (
        found.pattern !== null &&
        matches(view.topic.title, found.pattern) && (
          <h4 className={`col-start-1 mb-1 ${titleClass}`}>
            <Highlighted text={view.topic.title} pattern={found.pattern} />
          </h4>
        )
      )}
      <p
        className={`leading-loose palt ${solo ? "col-start-1 m-0 max-w-em-38 text-lg text-ink" : "col-start-2 mt-1 mb-0 max-w-em-38 text-base text-ink-2"} ${found.current === key ? `rounded-md ${hitClass} outline-offset-far` : ""}`}
      >
        <Highlighted text={view.topic.body} pattern={found.pattern} />
      </p>
      <Originals
        id={id}
        fold={view}
        noun="original"
        toggle={toggle}
        mark={mark}
        found={found}
        tint={tint}
        solo={solo}
      />
    </section>
  );
}

const meta = (digest: Digest, items: ReadonlyArray<ItemSummary>) => [
  timeSpan(items),
  plural(items.length, "message"),
  ...(digest.trigger === "manual" ? ["Manual"] : []),
];

function DigestCard({
  id,
  block,
  watch,
  mark,
  found,
  controls,
  tint,
  lead,
}: {
  id: ConversationId;
  block: Extract<Block, { _tag: "DigestCard" }>;
  watch: Watch;
  mark: Mark;
  found: Found;
  controls: Controls | null;
  tint: Tint;
  lead: boolean;
}) {
  const [, setUi] = useAtom(readerUi(id));
  const { digest, items, topics, uncited } = block;
  const solo = topics.length === 1;
  const only = topics[0];
  const pinned = solo && only?.open === true;
  const collapse = () =>
    setUi((ui) => ({ ...ui, shapes: new Map(ui.shapes).set(digest.id, "row") }));
  const unfoldOnly = () =>
    setUi((ui) => {
      const originals = new Set(ui.originals);
      if (only !== undefined) originals.delete(only.key);
      return { ...ui, originals };
    });
  const action: Action = { _tag: "Redo", id: digest.id };
  const run = controls?.run;
  const redoing =
    run?._tag === "Running" && run.range.from === digest.from_seq && run.range.to === digest.to_seq;
  const failed = run === undefined ? undefined : failedAt(run, action);
  const key = hitKey({ _tag: "Headline", digest: digest.id });
  return (
    <section
      className={`dc relative ${lead ? "mt-2 pt-3.5" : "mt-10 pt-7 shadow-rule-line"}`}
      aria-label={digest.headline}
      aria-busy={redoing || undefined}
      data-k={blockKey(block)}
    >
      <header
        className={`${bleedClass} ${pinned ? pinClass : ""}`}
        data-key={only?.key}
        data-k={`h-${digest.id}`}
        {...hitProps(found, key)}
      >
        {digest.from_seq !== digest.to_seq && (
          <p className="mt-0 mb-2 text-xs leading-4.5 text-ink-3 tabular-nums">
            {meta(digest, items).map((bit) => (
              <span key={bit} className={separatorClass}>
                {bit}
              </span>
            ))}
          </p>
        )}
        <div className="flex items-start gap-3">
          <h3
            className={`m-0 max-w-em-30 min-w-0 flex-1 font-display text-2xl leading-snug font-bold tracking-tight text-balance break-keep wrap-anywhere text-ink palt ${redoing ? fadeClass : ""} ${found.current === key ? `rounded-md ${hitClass} outline-offset-far` : ""}`}
          >
            <Highlighted text={digest.headline} pattern={found.pattern} />
          </h3>
          {solo && only?.open && (
            <Pin id={id} fold={(target) => unfold(target, true, unfoldOnly)} view={only} />
          )}
          <button
            type="button"
            className={`${pillClass} text-ink-2 shadow-ring-line transition-ink-ring duration-fast hover:text-ink hover:shadow-ring-ink-3 ${pinned ? "ml-0" : "ml-auto"}`}
            onClick={(event) => reshape(event.currentTarget, collapse)}
          >
            Collapse
          </button>
          {controls !== null && (
            <button
              type="button"
              className={`${pillClass} ml-1.5 transition-ink-ring-fade duration-fast enabled:hover:text-ink enabled:hover:shadow-ring-ink-3 disabled:cursor-default ${redoing ? "text-ink-2 opacity-full" : "text-ink-3 disabled:opacity-half"}`}
              title="Digest this range again with the current prompt and model"
              disabled={controls.run._tag === "Running"}
              onClick={() =>
                controls.act(action, { from: digest.from_seq, to: digest.to_seq }, items.length)
              }
            >
              {runs(controls.run, action)
                ? "Redoing…"
                : failed !== undefined
                  ? "Try again"
                  : "Redo"}
            </button>
          )}
        </div>
        {failed !== undefined && (
          <p className="mt-1.5 mb-0 text-xs text-warn" role="alert">
            Couldn't redo. {reason(failed.cause)} <LogPath failed={failed} block />
          </p>
        )}
      </header>
      <div className={`grid gap-6 ${solo ? "mt-2.5" : "mt-5.5"} ${redoing ? fadeClass : ""}`}>
        {topics.map((view) => (
          <Topic
            key={view.key}
            id={id}
            view={view}
            solo={solo}
            mark={mark}
            found={found}
            tint={tint}
          />
        ))}
        {uncited !== null && (
          <section
            className={`tp uncited relative grid items-start ${solo ? "solo grid-cols-1" : "grid-cols-topic"}`}
            data-k={`tp-${uncited.key}`}
            data-seqs={uncited.items.map(({ seq }) => seq).join(" ")}
          >
            <Originals
              id={id}
              fold={uncited}
              noun="other original"
              toggle={(target) => unfold(target, uncited.open, () => setUi(flipped(uncited)))}
              mark={mark}
              found={found}
              tint={tint}
              solo={solo}
            />
          </section>
        )}
      </div>
      <End seq={digest.to_seq} watch={watch} />
    </section>
  );
}

export function BlockView({
  id,
  block,
  watch,
  mark,
  found,
  controls,
  tint,
  lead,
}: {
  id: ConversationId;
  block: Block;
  watch: Watch;
  mark: Mark;
  found: Found;
  controls: Controls | null;
  tint: Tint;
  lead: boolean;
}) {
  const [, setUi] = useAtom(readerUi(id));
  const setPreview = useAtomSet(preview);
  const k = blockKey(block);
  switch (block._tag) {
    case "Marker":
      return (
        <div
          className="lr mt-4 mb-1 flex items-center gap-3 before:h-0.5 before:shrink-0 before:grow-0 before:basis-4.5 before:rounded-xs before:bg-ink after:h-0.5 after:flex-1 after:rounded-xs after:bg-ink"
          role="separator"
          data-k={k}
        >
          <span className="text-xs whitespace-nowrap text-ink-3">
            <b className="mr-2 font-bold text-ink">
              {block.kind === "all-new" ? "All new from here" : "Last read"}
            </b>
            {block.newCount} new
          </span>
        </div>
      );
    case "EarlierFold":
      return (
        <button
          type="button"
          className={`${foldClass} gap-3 pr-2 pl-4`}
          data-k={k}
          onClick={(event) =>
            reshape(event.currentTarget, () => setUi((ui) => ({ ...ui, earlier: true })))
          }
        >
          <span className="flex-none text-md font-bold whitespace-nowrap text-ink">
            {plural(block.digests.length, "earlier digest")}
          </span>
          <span className="min-w-0 truncate text-sm text-ink-3 tabular-nums">
            {timeSpan(block.items)} · {plural(block.items.length, "message")}
          </span>
          <span className="ml-auto h-7 flex-none rounded-full bg-island px-3 text-xs leading-7 font-semibold text-ink-2">
            Show
          </span>
        </button>
      );
    case "DigestRow":
      return (
        <div className="relative" data-k={k}>
          <button
            type="button"
            className={`${foldClass} gap-2.5 px-4 py-3`}
            aria-expanded={false}
            onClick={(event) =>
              reshape(event.currentTarget, () =>
                setUi((ui) => ({
                  ...ui,
                  shapes: new Map(ui.shapes).set(block.digest.id, "card"),
                })),
              )
            }
          >
            <span className="flex-none text-xs whitespace-nowrap text-ink-3 tabular-nums">
              {meta(block.digest, block.items).join(" · ")}
            </span>
            <span className="min-w-0 truncate text-md font-semibold text-ink-2 palt before:mr-2.5 before:font-normal before:text-ink-4 before:content-dot">
              {block.digest.headline}
            </span>
          </button>
          <End seq={block.digest.to_seq} watch={watch} />
        </div>
      );
    case "DigestCard":
      return (
        <DigestCard
          id={id}
          block={block}
          watch={watch}
          mark={mark}
          found={found}
          controls={controls}
          tint={tint}
          lead={lead}
        />
      );
    case "GapBar": {
      const { gap } = block;
      const action: Action = { _tag: "UpTo", seq: block.up_to };
      const failed = controls === null ? undefined : failedAt(controls.run, action);
      if (failed !== undefined && controls !== null) {
        return (
          <Failure failed={failed} controls={controls} className="mt-3.5" gap={block.first} k={k} />
        );
      }
      return (
        <div
          className={`${lineClass} mt-3.5 max-wide:flex-wrap max-wide:gap-y-1.5`}
          data-gap={block.first}
          data-k={k}
        >
          <span className={`${lineKeyClass} text-ink-2`}>Not digested</span>
          <span className="flex-none">{plural(block.run_items, "message")} above</span>
          {controls !== null && gap !== null && (
            <button
              type="button"
              className={`${chipClass} pl-2.5 ${runs(controls.run, action) ? "opacity-full" : "disabled:opacity-half"}`}
              disabled={controls.run._tag === "Running"}
              onClick={(event) =>
                controls.act(
                  action,
                  { from: gap.from_seq, to: gap.to_seq },
                  gap.items,
                  event.currentTarget.closest("[data-gap]"),
                )
              }
              {...previewing(setPreview, { from: gap.from_seq, to: gap.to_seq })}
            >
              <Arrow up />
              {runs(controls.run, action) ? "Digesting…" : earlierLabel(gap)}
            </button>
          )}
        </div>
      );
    }
    case "Tail": {
      const { now, backlog } = block;
      const action: Action = { _tag: "Now" };
      const failed = controls === null ? undefined : failedAt(controls.run, action);
      if (failed !== undefined && controls !== null) {
        return (
          <Failure failed={failed} controls={controls} className={lead ? "mt-3" : "mt-10"} k={k} />
        );
      }
      return (
        <div
          className={`${lineClass} max-wide:flex-wrap max-wide:gap-y-1.5 ${lead ? "mt-3" : "mt-10"}`}
          data-k={k}
        >
          <span className={`${lineKeyClass} text-ink-2`}>Not digested</span>
          {backlog !== null && (
            <>
              <span className="flex-none">
                {backlog.chars.toLocaleString("en")} of {backlog.threshold.toLocaleString("en")}
              </span>
              <span
                className="relative h-px min-w-10 flex-1 bg-line max-wide:order-5 max-wide:basis-full"
                role="meter"
                aria-label="Characters toward the next digest"
                aria-valuemin={0}
                aria-valuemax={backlog.threshold}
                aria-valuenow={Math.min(backlog.chars, backlog.threshold)}
                style={{ "--p": Math.min(1, backlog.chars / backlog.threshold) } as CSSProperties}
              >
                <i
                  className={`absolute -top-half-px left-0 h-0.5 w-meter rounded-xs ${tintClass[tint]}`}
                />
              </span>
            </>
          )}
          {controls !== null && now !== null && (
            <button
              type="button"
              className="ml-auto h-7.5 flex-none rounded-full bg-capbg px-3.5 text-xs font-bold text-cap-1 elevation-notch transition-press-bg duration-fast enabled:hover:bg-primary-hover active:scale-press disabled:cursor-default disabled:opacity-half"
              disabled={controls.run._tag === "Running"}
              onClick={() =>
                controls.act(action, { from: now.from_seq, to: now.to_seq }, now.items)
              }
              {...previewing(setPreview, { from: now.from_seq, to: now.to_seq })}
            >
              Digest now
            </button>
          )}
        </div>
      );
    }
    case "Skeleton":
      return <Skeleton items={block.items} tint={tint} lead={lead} />;
    case "Day":
      return <DayLine at={block.at} />;
    case "Bubbles":
      return (
        <Group
          id={id}
          group={block}
          watch={watch}
          mark={mark}
          found={found}
          tint={tint}
          controls={controls}
        />
      );
  }
}

const blockKey = (block: Block) => {
  switch (block._tag) {
    case "Marker":
    case "Tail":
    case "Skeleton":
      return block._tag;
    case "EarlierFold":
      return `earlier-${block.digests[0]?.id}`;
    case "DigestRow":
    case "DigestCard":
      return `d-${block.digest.id}`;
    case "GapBar":
      return `gap-${block.first}`;
    case "Day":
      return `day-${block.at}`;
    case "Bubbles":
      return `g-${block.items[0]?.seq}`;
  }
};

const land = (root: HTMLElement | null) => {
  const scroller = root?.closest(".r-scroll");
  if (root === null || scroller == null) return;
  const marker = root.querySelector(".lr");
  scroller.scrollTop =
    marker === null
      ? scroller.scrollHeight
      : scroller.scrollTop +
        marker.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        covered(root) -
        16;
  quiet(scroller.scrollTop);
};

const hold = (anchor: Element | null | undefined, digests: ReadonlyArray<number>) => {
  const scroller = anchor?.closest(".r-scroll");
  if (!(anchor instanceof HTMLElement) || scroller == null) return () => {};
  const top = anchor.getBoundingClientRect().top;
  const view = scroller.getBoundingClientRect();
  if (top < view.top || top > view.bottom) return () => {};
  return () => {
    const moved =
      scroller.querySelector(`[data-gap="${anchor.dataset.gap}"]`) ??
      scroller.querySelector(`[data-k="d-${digests[0]}"]`);
    if (moved === null) return;
    quiet();
    scroller.scrollTop += moved.getBoundingClientRect().top - top;
  };
};

function Conversation({
  id,
  detail,
  frozen,
  watch,
  mark,
  hidden,
}: {
  id: ConversationId;
  detail: Detail;
  frozen: number;
  watch: Watch;
  mark: Mark;
  hidden: boolean;
}) {
  const landed = useRef(false);
  const article = useRef<HTMLElement | null>(null);
  const [ui, setUi] = useAtom(readerUi(id));
  const [folded, setFolded] = useAtom(headerFold(id));
  const { view } = useAtomValue(route);
  const hue = tagHue(useAtomValue(tagOrder), view, detail);
  const run = useAtomValue(digestRun(id));
  const start = useAtomSet(runDigest);
  const setPreview = useAtomSet(preview);
  const pattern = useAtomValue(searchPattern);
  const hits = Option.getOrElse(useAtomValue(searchHits(id)), () => []);
  const at = useAtomValue(hitAt(id));
  const current = hits[at];
  const found: Found = {
    pattern,
    hits: new Map(hits.map((hit) => [hitKey(hit), hit])),
    current: current === undefined ? null : hitKey(current),
  };
  const controls: Controls | null =
    detail.digest.earlier === null
      ? null
      : {
          run,
          act: (action, range, items, anchor) => {
            setPreview(null);
            start({
              id,
              action,
              range,
              items,
              land: (digests) => {
                const armed = before(article.current, () => hold(anchor, digests));
                setUi((current) => ({
                  ...current,
                  shapes: new Map([
                    ...current.shapes,
                    ...digests.map((digest) => [digest, "card"] as const),
                  ]),
                }));
                return () => after(armed);
              },
            });
          },
        };
  const newCount = detail.items.filter(({ seq }) => seq > frozen).length;
  const home = homeTag(view, detail.tags);
  const tags = detail.tags.filter((tag) => tag !== home);
  const blocks = reader(
    detail,
    frozen,
    revealing(ui, run),
    run._tag === "Running" ? run.range : null,
  );
  return (
    <article
      className="relative px-reader pt-2 pb-30"
      data-folded={folded || undefined}
      ref={(root) => {
        article.current = root;
        if (hidden || landed.current || root === null) return;
        landed.current = true;
        land(root);
      }}
      aria-label={detail.title}
      style={hue === undefined ? undefined : ({ "--bh": hue } as CSSProperties)}
    >
      <header className="pointer-events-none sticky top-0 z-ctx -mx-bleed" data-ctx>
        <div className="pointer-events-auto bg-island px-bleed pb-2" inert={folded}>
          <p className="mt-0 mb-1.5 text-xs text-ink-3">
            {home !== undefined && (
              <b className={`font-semibold text-ink-2 ${separatorClass}`}>{home}</b>
            )}
            {tags.map((tag) => (
              <span key={tag} className={separatorClass}>
                {tag}
              </span>
            ))}
            <span className={separatorClass}>{detail.source}</span>
            <span className={separatorClass}>
              {newCount > 0 ? `${newCount} new this time` : "Read"}
            </span>
            <span className={separatorClass}>
              {plural(detail.items.length, "message")} ·{" "}
              {plural(participants(detail), "person", "people")}
            </span>
            <span className={separatorClass}>
              {day(detail.first_at)} – {day(detail.last_at)}
            </span>
          </p>
          <h2 className="m-0 font-display text-2xl leading-snug font-extrabold tracking-tight text-balance palt">
            <Highlighted text={detail.title} pattern={pattern} />
          </h2>
        </div>
        <button
          type="button"
          className="pointer-events-auto absolute inset-x-0 top-1 flex h-11 items-center gap-2.5 rounded-full bg-dock px-4 text-left elevation-float backdrop-blur-lg backdrop-saturate-pin"
          inert={!folded}
          aria-label={`${detail.title}: show the conversation header`}
          onClick={() => setFolded(false)}
        >
          <span
            className={`size-2 flex-none rounded-circle ${tintClass[hue === undefined ? "ink" : "tag"]}`}
            aria-hidden="true"
          />
          <b className="min-w-0 truncate text-sm font-bold text-ink">{detail.title}</b>
          <span className="ml-auto flex-none text-xs text-ink-3 tabular-nums max-wide:hidden">
            {newCount > 0 ? `${newCount} new` : plural(detail.items.length, "message")}
          </span>
        </button>
      </header>
      {blocks.map((block, index) => (
        <BlockView
          key={blockKey(block)}
          id={id}
          block={block}
          watch={watch}
          mark={mark}
          found={found}
          controls={controls}
          tint={hue === undefined ? "ink" : "tag"}
          lead={index === 0 || blocks[index - 1]?._tag === "Marker"}
        />
      ))}
      <div data-ghosts aria-hidden="true" inert />
    </article>
  );
}

const dockLabels: Record<DockAction, string> = {
  Done: "Done",
  Restore: "Restore",
  MarkUnread: "Mark unread",
  Mute: "Mute",
};

const dockItemClass =
  "h-9.5 items-center gap-2 rounded-full text-sm whitespace-nowrap no-underline transition-press-bg duration-fast";

function Dock({ id }: { id: ConversationId }) {
  const shown = useAtomValue(dock(id));
  const [current, navigate] = useAtom(route);
  const { unread } = useAtomValue(reading(id));
  const run = useAtomSet(dismiss);
  if (Option.isNone(shown)) return null;
  const { actions, target, open } = shown.value;
  return (
    <div
      className="r-dock absolute inset-x-0 bottom-4 mx-auto flex w-fit max-w-dock items-center gap-1 rounded-full bg-dock p-1.5 elevation-float backdrop-blur-dock backdrop-saturate-dock max-wide:bottom-dock-safe max-wide:gap-0.5"
      role="group"
      aria-label="Conversation actions"
    >
      <button
        type="button"
        className={`${dockItemClass} hidden px-4 font-semibold text-ink hover:bg-hover active:scale-press max-wide:inline-flex max-wide:px-2.5`}
        aria-label="Back"
        onClick={() => navigate({ _tag: "Go", to: { ...current, conversation: Option.none() } })}
      >
        <svg className={`size-4.5 stroke-1.8 ${iconClass}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3.5L5.5 8l4.5 4.5" />
        </svg>
      </button>
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={`${dockItemClass} inline-flex font-semibold active:scale-press ${action === "Done" || action === "Restore" ? "bg-capbg px-5 text-cap-1 hover:bg-primary-hover" : "px-4 text-ink hover:bg-hover max-wide:px-3.5"}`}
          aria-keyshortcuts={action === "Done" ? "e" : undefined}
          onClick={() => (action === "MarkUnread" ? unread(null) : run({ act: action, target }))}
        >
          {dockLabels[action]}
          {action === "Done" && (
            <kbd
              className="rounded-sm px-1 py-0.5 font-sans text-2xs leading-none font-semibold opacity-muted shadow-ring-current max-wide:hidden"
              aria-hidden="true"
            >
              e
            </kbd>
          )}
        </button>
      ))}
      {open !== null && (
        <a
          className={`${dockItemClass} inline-flex px-4 font-medium text-ink-3 hover:text-ink max-wide:px-2.5`}
          href={open.link}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open in ${open.label}`}
        >
          <span className="max-wide:hidden">Open in {open.label}</span>
          <svg
            className={`-ml-1 size-3.25 stroke-1.6 ${iconClass} max-wide:ml-0 max-wide:size-4.5`}
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path d="M5.5 4.5h6v6M11.2 4.8L4.5 11.5" />
          </svg>
        </a>
      )}
    </div>
  );
}

// Status hides the reader instead of unmounting it, so closing Status returns to the same reading state
// and scroll position.
export function Reader({ id, hidden }: { id: ConversationId; hidden: boolean }) {
  const result = useAtomValue(conversation(id));
  const { frozen, seen, dispatch, watch, unread } = useAtomValue(reading(id));
  const [, setPins] = useAtom(pins(id));
  const [folded, setFolded] = useAtom(headerFold(id));
  useAtomMount(landing(id));
  useAtomMount(following(id));
  const arm = () => dispatch({ _tag: "Input" });
  const track = (event: UIEvent<HTMLElement>) => {
    const fold = scrolled(folded, event.currentTarget.scrollTop);
    if (fold !== folded) setFolded(fold);
    const next = new Map<TopicKey, number>();
    for (const head of event.currentTarget.querySelectorAll<HTMLElement>(
      ".pin:not([data-ghosts] *)",
    )) {
      const bottom = head.getBoundingClientRect().bottom;
      const originals = [
        ...(head.closest(".tp, .dc")?.querySelectorAll(".tp:not(.uncited) > .unf .bl") ?? []),
      ];
      const at = originals.findIndex((bl) => bl.getBoundingClientRect().bottom > bottom + 8);
      next.set(head.dataset.key as TopicKey, at < 0 ? originals.length : at + 1);
    }
    setPins((previous) =>
      next.size === previous.size && [...next].every(([key, at]) => previous.get(key) === at)
        ? previous
        : next,
    );
  };
  return (
    <>
      <div
        className="r-scroll"
        hidden={hidden}
        onWheel={arm}
        onTouchMove={arm}
        onPointerDown={arm}
        onKeyDown={(event: KeyboardEvent) => {
          if (scrollKeys[event.key]) arm();
        }}
        onScroll={track}
      >
        {AsyncResult.isFailure(result) && !AsyncResult.isSuccess(result) ? (
          <div className="flex h-full flex-col items-center justify-center px-reader pb-16">
            <p className="m-0 mb-5 font-display text-lg leading-snug font-semibold text-ink">
              Can't load this conversation.
            </p>
          </div>
        ) : (
          AsyncResult.isSuccess(result) &&
          Option.isSome(frozen) && (
            <Conversation
              key={id}
              id={id}
              detail={result.value}
              frozen={frozen.value}
              watch={watch}
              mark={{ seen, unread }}
              hidden={hidden}
            />
          )
        )}
      </div>
      {!hidden && <Dock id={id} />}
    </>
  );
}
