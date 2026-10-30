import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Fragment, type MouseEvent, useCallback, useRef, useState } from "react";
import { Avatars } from "./Avatar.tsx";
import { plural } from "./Health.ts";
import { Link } from "./Link.tsx";
import {
  type Clause,
  chips,
  clearedWidget,
  enumerate,
  sentence,
  type Widget,
  type WidgetKind,
  widgetDescription,
} from "./Notch.ts";
import { chipText, type Field, fieldOf, queryOf, queryText, typed } from "./Query.ts";
import { hitAt, searchHits, searchMatchedIn, stepHit } from "./Reading.ts";
import { groups, type ResultGroup } from "./Results.ts";
import {
  type ConversationId,
  href,
  listTops,
  type Route,
  route,
  statusOpen,
  type View,
} from "./Route.ts";
import { CloseIcon, StatusIcon } from "./Status.tsx";
import {
  counts,
  found,
  leaveSearch,
  pickedGroup,
  searchGroup,
  searching,
  searchOpen,
  searchQuery,
  searchResult,
  tagOrder,
} from "./Weir.ts";

const measureCap = (cap: HTMLDivElement) => {
  const observer = new ResizeObserver(() =>
    document.documentElement.style.setProperty("--cap-h", `${cap.offsetHeight}px`),
  );
  observer.observe(cap);
  return () => observer.disconnect();
};

const fadeStrip = (strip: HTMLElement) => {
  const fade = () => {
    strip.toggleAttribute("data-fl", strip.scrollLeft > 1);
    strip.toggleAttribute("data-fr", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  };
  const resized = new ResizeObserver(fade);
  const observeChips = () => {
    for (const chip of strip.children) resized.observe(chip);
  };
  const mutated = new MutationObserver(() => {
    observeChips();
    fade();
  });
  resized.observe(strip);
  observeChips();
  mutated.observe(strip, { childList: true });
  const turn = (event: WheelEvent) => {
    if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    const unit = event.deltaMode === 2 ? strip.clientWidth : event.deltaMode === 1 ? 16 : 1;
    strip.scrollLeft += event.deltaY * unit;
  };
  strip.addEventListener("scroll", fade, { passive: true });
  strip.addEventListener("wheel", turn, { passive: false });
  return () => {
    resized.disconnect();
    mutated.disconnect();
    strip.removeEventListener("scroll", fade);
    strip.removeEventListener("wheel", turn);
  };
};

const scrollStrip = (arrow: HTMLElement, direction: 1 | -1) => {
  const strip = arrow.parentElement?.querySelector(".cws");
  if (!(strip instanceof HTMLElement)) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  strip.scrollBy({
    left: (strip.clientWidth - 64) * direction,
    behavior: reduce ? "auto" : "smooth",
  });
};

function Chevron({ direction }: { readonly direction: 1 | -1 }) {
  return (
    <svg
      className="size-4 fill-none stroke-current stroke-1.8 linecap-round linejoin-round"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d={direction === -1 ? "M10 3.5L5.5 8l4.5 4.5" : "M6 3.5L10.5 8 6 12.5"} />
    </svg>
  );
}

function StripArrow(props: { readonly direction: 1 | -1 }) {
  const prev = props.direction === -1;
  return (
    <button
      type="button"
      className={`invisible absolute top-half -mt-3.5 grid size-7 place-items-center rounded-circle bg-capbg text-cap-2 opacity-none transition-fade-tint-shown hover:bg-cap-raised hover:text-cap-1 active:scale-press-deep ${prev ? "left-0 peer-data-fl:visible peer-data-fl:opacity-full" : "right-0 peer-data-fr:visible peer-data-fr:opacity-full"}`}
      tabIndex={-1}
      aria-label={prev ? "Scroll tags left" : "Scroll tags right"}
      onClick={({ currentTarget }) => scrollStrip(currentTarget, props.direction)}
    >
      <Chevron direction={props.direction} />
    </button>
  );
}

const hands = ["pointerdown", "wheel", "touchstart", "keydown", "focusin"] as const;

// The current view's chip scrolls to the middle whenever what is on screen moves (view, conversation, or the
// pill appearing), never under a hand that is scrolling the strip. Until a hand touches it, the chip stays
// centred while the pill settles its width.
function ViewStrip({
  widgets,
  active,
  shown,
}: {
  readonly widgets: ReadonlyArray<Widget>;
  readonly active: View | null;
  readonly shown: string;
}) {
  const centred = useRef<string | null>(null);
  const loaded = widgets.length > 0;
  const centre = useCallback(
    (wrap: HTMLSpanElement | null) => {
      const strip = wrap?.querySelector<HTMLElement>(".cws");
      const chip = strip?.querySelector<HTMLElement>(".cw.on");
      if (!loaded || wrap == null || strip == null || chip == null) return;
      const smooth =
        centred.current !== null &&
        centred.current !== shown &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches;
      centred.current = shown;
      const goal = () => {
        const box = strip.getBoundingClientRect();
        const at = chip.getBoundingClientRect();
        return strip.scrollLeft + at.left - box.left + at.width / 2 - strip.clientWidth / 2;
      };
      let left = goal();
      strip.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
      const settle = new ResizeObserver(() => {
        const next = goal();
        if (Math.abs(next - left) < 1) return;
        left = next;
        strip.scrollTo({ left, behavior: "auto" });
      });
      settle.observe(strip);
      for (const each of strip.children) settle.observe(each);
      const release = () => {
        settle.disconnect();
        for (const hand of hands) wrap.removeEventListener(hand, release);
      };
      for (const hand of hands) wrap.addEventListener(hand, release, { passive: true });
      return release;
    },
    [shown, loaded],
  );
  return (
    <span className="relative flex min-w-0 shrink-100 overflow-hidden" ref={centre}>
      <nav
        className="cws peer flex min-w-0 items-center gap-0.5 overflow-x-auto overscroll-x-contain scrollbar-none"
        aria-label="Views"
        ref={fadeStrip}
      >
        {widgets.map((widget) => (
          <Chip key={widget.view} widget={widget} active={active} />
        ))}
      </nav>
      <StripArrow direction={-1} />
      <StripArrow direction={1} />
    </span>
  );
}

const viewRoute = (view: View): Route => ({ view, query: "", conversation: Option.none() });

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`size-4.5 fill-none stroke-current stroke-1.7 linecap-round ${className}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.4 10.4l3.4 3.4" />
    </svg>
  );
}

const toolClass = (on: boolean) =>
  `relative grid size-10 place-items-center rounded-circle transition-tint ${on ? "bg-cap-1 text-on-c" : "text-cap-2 hover:bg-cap-hover hover:text-cap-1"}`;

const chipShapeClass =
  "inline-flex h-9 flex-none items-center gap-1.5 rounded-full font-sans text-md leading-none font-medium transition-bg max-wide:h-8.5 max-wide:px-2.5 max-wide:text-sm";

function StatusButton({ chip, alert }: { chip: boolean; alert: boolean }) {
  const [open, setOpen] = useAtom(statusOpen);
  return (
    <button
      type="button"
      className={
        chip
          ? `${chipShapeClass} relative ml-0.5 px-3 ${open ? "bg-cap-1 text-on-c" : "text-cap-2 hover:bg-cap-hover hover:text-cap-1"}`
          : toolClass(open)
      }
      aria-label="Status"
      title="Status"
      aria-pressed={open}
      aria-description={alert ? "Needs attention" : undefined}
      onClick={() => setOpen(!open)}
    >
      <StatusIcon />
      <i
        className={`absolute size-2 rounded-circle bg-warn-cap transition-pop motion-reduce:transition-none ${chip ? "top-1.5 right-1.5" : "top-2 right-2"} ${alert ? "scale-none opacity-full" : "scale-dot opacity-none"} ${open ? "shadow-halo-cap-1" : "shadow-halo-capbg"}`}
        aria-hidden="true"
      />
    </button>
  );
}

const glueClass = "font-normal text-cap-2";

const widgetClass = (on: boolean) =>
  `relative inline-block mx-em-0.05 rounded-chip px-em-0.3 py-em-0.05 whitespace-nowrap transition-bg ${on ? "bg-cap-1 text-on-c" : "hover:bg-cap-hover"}`;

const widgetCountClass = (tail: boolean) =>
  `mr-em-0.05 inline-block tracking-tighter tabular-nums ${tail ? "font-semibold" : "font-bold"}`;

export type Roll = "up" | "down";

export const rollOf = (from: number, to: number): Roll => (to > from ? "up" : "down");

export type Seen<A, B> = { readonly value: A; readonly change: B | undefined };

export const changeOf = <A, B>(
  seen: Seen<A, B>,
  value: A,
  change: (from: A, to: A) => B,
): Seen<A, B> =>
  Object.is(seen.value, value) ? seen : { value, change: change(seen.value, value) };

export const popOf = (_: boolean, now: boolean) => now;

const useChange = <A, B>(value: A, change: (from: A, to: A) => B): B | undefined => {
  const [seen, setSeen] = useState<Seen<A, B>>({ value, change: undefined });
  const next = changeOf(seen, value, change);
  if (next !== seen) setSeen(next);
  return next.change;
};

function Count({
  value,
  className,
  quick = false,
}: {
  value: number;
  className: string;
  quick?: boolean;
}) {
  const roll = useChange(value, rollOf);
  return (
    <span key={value} className={className} data-roll={roll} data-quick={quick || undefined}>
      {value}
    </span>
  );
}

export function SentenceWidget({
  widget,
  active,
  tail = false,
}: {
  widget: Widget;
  active: View | null;
  tail?: boolean;
}) {
  const on = active === widget.view;
  const pop = useChange(on, popOf) === true;
  return (
    <Link
      to={viewRoute(widget.view)}
      current={on}
      pop={pop}
      className={`${widgetClass(on)} leading-snug no-underline ${on ? "" : widget.kind === "clear" ? "text-cap-2" : "text-cap-1"}`}
      description={widgetDescription(widget)}
    >
      {widget.kind === "cleared" ? (
        <>
          <span className={on ? "" : "text-cap-2"}>{widget.name}</span>{" "}
          <Count value={widget.count} className={widgetCountClass(tail)} />
        </>
      ) : (
        <>
          <Avatars senders={widget.senders} on={on} />
          {widget.kind !== "clear" && (
            <Count value={widget.count} className={widgetCountClass(tail)} />
          )}
          {widget.kind !== "clear" && " "}
          <span className={tail ? "font-medium" : "font-semibold"}>{widget.name}</span>
        </>
      )}
    </Link>
  );
}

const endGlueClass = (afterOn: boolean, tail: boolean) =>
  `${glueClass} ${afterOn ? "" : tail ? "-ml-em-0.3" : "-ml-em-0.25"}`;

function SentenceClause({
  clause,
  active,
  tail = false,
}: {
  clause: Clause;
  active: View | null;
  tail?: boolean;
}) {
  return clause.map(({ lead, widget, end }, at) => (
    <Fragment key={widget.view}>
      {at > 0 && " "}
      <span className="whitespace-nowrap">
        {lead !== "" && <span className={glueClass}>{lead}</span>}
        <SentenceWidget widget={widget} active={active} tail={tail} />
        {end !== "" && <span className={endGlueClass(active === widget.view, tail)}>{end}</span>}
      </span>
    </Fragment>
  ));
}

const chipKindClass: Record<
  WidgetKind,
  { readonly count: string; readonly name: string; readonly tone: string }
> = {
  updates: { count: "font-bold", name: "", tone: "" },
  quiet: { count: "font-semibold", name: "font-medium", tone: "text-cap-2" },
  clear: { count: "font-bold", name: "", tone: "text-cap-3" },
  cleared: { count: "font-medium", name: "font-medium", tone: "text-cap-2" },
};

export function Chip({
  widget,
  active,
  className = "",
}: {
  widget: Widget;
  active: View | null;
  className?: string;
}) {
  const on = active === widget.view;
  const pop = useChange(on, popOf) === true;
  const kind = chipKindClass[widget.kind];
  const tone = on ? "text-on-c" : kind.tone;
  const count = (
    <Count
      value={widget.count}
      className={`inline-block font-display text-base leading-none tracking-tighter ${kind.count} ${tone}`}
    />
  );
  const name = <span className={`${kind.name} ${tone}`}>{widget.name}</span>;
  return (
    <Link
      to={viewRoute(widget.view)}
      current={on}
      pop={pop}
      className={`cw ${chipShapeClass} px-3.5 no-underline ${on ? "bg-cap-1 text-on-c" : "text-cap-1 hover:bg-cap-hover"} ${className}`}
      description={widgetDescription(widget)}
    >
      {widget.kind === "cleared" ? (
        <>
          {name} {count}
        </>
      ) : (
        <>
          <Avatars senders={widget.senders} className="top-0 mr-px -ml-1.5 text-av-sm" on={on} />
          {widget.kind !== "clear" && count}
          {widget.kind !== "clear" && " "}
          {name}
        </>
      )}
    </Link>
  );
}

// Safari does not focus links or buttons on click, so the input's blur would carry no relatedTarget.
const keepFocus = (event: MouseEvent) => {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
};

type EnterKey = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode"
>;

export const hitStep = (event: EnterKey): 1 | -1 | null => {
  if (event.key !== "Enter" || event.altKey || event.ctrlKey || event.metaKey) return null;
  // Safari sends the Enter that commits an IME composition with isComposing false but keyCode 229.
  if (event.isComposing || event.keyCode === 229) return null;
  return event.shiftKey ? -1 : 1;
};

function QueryField({ stepping, form }: { stepping: ConversationId | null; form: CapForm }) {
  const [current, navigate] = useAtom(route);
  const tags = useAtomValue(tagOrder);
  const opened = useAtomValue(searchOpen);
  const setGroup = useAtomSet(searchGroup);
  const [tops, setTops] = useAtom(listTops);
  const step = useAtomSet(stepHit);
  const field = fieldOf(current.query, tags);
  const wide = form === "search";
  const write = (next: Field) => {
    const query = queryOf(next);
    if (query === "") setGroup(Option.none());
    if (current.query === "" && query !== "") {
      setTops(new Map(tops).set(href(current), document.querySelector(".list")?.scrollTop ?? 0));
    }
    navigate({ _tag: "Type", query });
  };
  return (
    <span
      className={`grid items-center ${wide ? "min-w-0 flex-1 grid-cols-query-wide" : "min-w-auto flex-initial grid-cols-query"}`}
    >
      {field.chips.length > 0 && (
        <span className="-my-1 mr-0.5 -ml-1 flex gap-1.5 overflow-x-auto overscroll-x-contain p-1 scrollbar-none">
          {field.chips.map((chip, at) => (
            <span
              key={chipText(chip)}
              data-chip
              className="inline-flex h-7.5 flex-none items-center rounded-full bg-cap-hover pr-0.5 pl-3 font-sans text-md leading-none font-semibold whitespace-nowrap text-cap-1"
            >
              <span className="mr-0.5 font-medium text-cap-2">{chip.key}:</span>
              <span>{chip.value}</span>
              <button
                type="button"
                className="ml-1 grid size-6 place-items-center rounded-circle text-cap-2 transition-tint hover:bg-cap-hover hover:text-cap-1"
                aria-label={`Remove ${chipText(chip)}`}
                title="Remove"
                onClick={() =>
                  write({ ...field, chips: field.chips.filter((_, index) => index !== at) })
                }
              >
                <CloseIcon small />
              </button>
            </span>
          ))}
        </span>
      )}
      <input
        className={`cap-in col-2 h-9 rounded-full border-none border-current bg-cap-hover px-3.5 py-0 font-sans text-md leading-none font-medium text-cap-1 placeholder:text-cap-3 ${wide ? "w-full min-w-em-6" : "w-em-9 max-wide:w-em-6"}`}
        type="search"
        aria-label="Search"
        placeholder="Search"
        autoFocus={opened}
        value={field.rest}
        onChange={({ target: { value } }) => write(typed(field, value, tags, false))}
        onBlur={() => {
          const next = typed(field, field.rest, tags, true);
          if (next.chips !== field.chips) write(next);
        }}
        onKeyDown={(event) => {
          const by = hitStep(event.nativeEvent);
          if (stepping !== null && by !== null) {
            event.preventDefault();
            step({ id: stepping, by });
            return;
          }
          if (event.key !== "Backspace" || field.rest !== "" || field.chips.length === 0) return;
          event.preventDefault();
          write({ ...field, chips: field.chips.slice(0, -1) });
        }}
      />
    </span>
  );
}

function GroupWidget({ group, on }: { group: ResultGroup; on: boolean }) {
  const setGroup = useAtomSet(searchGroup);
  return (
    <button
      type="button"
      className={`${widgetClass(on)} ${on ? "" : "text-cap-1"}`}
      aria-pressed={on}
      aria-description={on ? "Show all results" : "Show only these"}
      onClick={() => setGroup(on ? Option.none() : Option.some(group.view))}
    >
      <Avatars senders={group.senders} className="-top-em-0.05 mr-em-0.1" on={on} />
      <Count value={group.count} className={widgetCountClass(false)} quick />{" "}
      <span className="font-semibold">{group.name}</span>
    </button>
  );
}

const sentenceMainClass =
  "m-0 font-display text-2xl leading-relaxed font-medium tracking-snug text-balance text-cap-1 max-wide:text-xl";
const sentenceSearchClass = `${sentenceMainClass} wrap-anywhere`;
const sentenceTailClass = "mx-0 mt-1 mb-0 font-sans text-md leading-loose font-normal text-cap-2";
const allClearClass = "font-bold text-cap-1";
const hintCodeClass =
  "rounded-sm bg-cap-hover px-1.5 py-px font-mono text-em-sm leading-auto font-medium text-cap-1";

function SearchSentence() {
  const active = useAtomValue(searching);
  const query = useAtomValue(searchQuery);
  const result = useAtomValue(searchResult);
  const results = useAtomValue(found);
  const tags = useAtomValue(tagOrder);
  const picked = useAtomValue(pickedGroup);
  if (!active) {
    return (
      <p className={sentenceTailClass}>
        Searches titles, digests, originals, senders and sources, done and muted included. Every
        word must appear. Narrow with <code className={hintCodeClass}>from:</code>{" "}
        <code className={hintCodeClass}>in:</code> <code className={hintCodeClass}>source:</code>
      </p>
    );
  }
  const quoted = `“${queryText(query)}”`;
  return Option.match(results, {
    onNone: () =>
      AsyncResult.isFailure(result) ? (
        <p className={sentenceSearchClass}>
          <span className={allClearClass}>Can't search right now.</span>
        </p>
      ) : (
        <p className={sentenceSearchClass}>
          <span className={glueClass}>Searching for {quoted}…</span>
        </p>
      ),
    onSome: (list) =>
      list.length === 0 ? (
        <>
          <p className={sentenceSearchClass}>
            <span className={allClearClass}>Nothing matches {quoted}.</span>
          </p>
          <p className={sentenceTailClass}>Try fewer words, or drop a filter.</p>
        </>
      ) : (
        <>
          <p className={sentenceSearchClass}>
            <span
              className={glueClass}
            >{`${quoted} ${query.text === "" ? "matches" : "appears in"} `}</span>
            {enumerate(groups(list, tags), "", ".").map(({ lead, widget, end }, at) => {
              const on = Option.contains(picked, widget.view);
              return (
                <Fragment key={widget.view}>
                  {at > 0 && " "}
                  <span className="whitespace-nowrap">
                    {lead !== "" && <span className={glueClass}>{lead}</span>}
                    <GroupWidget group={widget} on={on} />
                    {end !== "" && <span className={endGlueClass(on, false)}>{end}</span>}
                  </span>
                </Fragment>
              );
            })}
          </p>
          <p className={sentenceTailClass}>
            {plural(list.length, "conversation")}.{" "}
            {Option.isSome(picked)
              ? "Click the lit group again to see all."
              : "Click a group to see only it."}
          </p>
        </>
      ),
  });
}

const hitCountClass =
  "mr-1.5 font-display text-md leading-none font-semibold whitespace-nowrap text-cap-2 tabular-nums";

function HitStepper({ id }: { id: ConversationId }) {
  const hits = useAtomValue(searchHits(id));
  const matched = useAtomValue(searchMatchedIn(id));
  const at = useAtomValue(hitAt(id));
  const step = useAtomSet(stepHit);
  if (Option.isNone(hits)) return null;
  const total = hits.value.length;
  const stepperClass =
    "flex flex-none items-center before:mr-3 before:ml-3.5 before:h-4.5 before:w-px before:bg-cap-rule max-wide:shrink";
  if (total === 0) {
    return (
      <span className={stepperClass}>
        <span className="mr-1.5 font-sans text-sm leading-none font-medium whitespace-nowrap text-cap-2 max-wide:leading-tight max-wide:whitespace-normal">
          {Option.getOrNull(matched)}
        </span>
      </span>
    );
  }
  return (
    <span className={stepperClass}>
      <span className={hitCountClass} role="status" aria-label={`Match ${at + 1} of ${total}`}>
        <b className="font-bold text-cap-1">{at + 1}</b>
        <span className="mx-0.5 text-cap-2">/</span>
        {total}
      </span>
      {([-1, 1] as const).map((direction) => (
        <button
          key={direction}
          type="button"
          className="grid size-9 place-items-center rounded-circle text-cap-1 transition-bg enabled:hover:bg-cap-hover enabled:active:scale-press-firm disabled:cursor-default disabled:text-cap-3 disabled:opacity-half"
          aria-label={direction === -1 ? "Previous match" : "Next match"}
          title={direction === -1 ? "Previous match" : "Next match"}
          disabled={direction === -1 ? at === 0 : at === total - 1}
          onClick={() => step({ id, by: direction })}
        >
          <Chevron direction={direction} />
        </button>
      ))}
    </span>
  );
}

export type CapForm = "full" | "compact" | "search" | "result";

const capClass = (compact: boolean) =>
  `cap fixed top-edge-gap left-reader-gap z-cap mx-auto flex flex-col bg-capbg text-cap-1 elevation-notch **:focus-visible:outline-cap-1 **:focus-visible:outline-offset-near max-wide:left-edge ${compact ? "compact w-fit rounded-full wide:right-stage-gap wide:max-w-compact" : "right-stage-gap rounded-notch max-wide:right-edge"}`;

const capDivClass = "mr-2.5 ml-3.5 h-4.5 w-px flex-none bg-cap-rule max-wide:mr-1.5 max-wide:ml-2";

export function Cap({ form, alert }: { form: CapForm; alert: boolean }) {
  const current = useAtomValue(route);
  const setSearching = useAtomSet(searchOpen);
  const leave = useAtomSet(leaveSearch);
  const loaded = AsyncResult.getOrElse(AsyncResult.map(useAtomValue(counts), Option.some), () =>
    Option.none(),
  );
  const active = current.query === "" ? current.view : null;
  const result = form === "result";
  return (
    <div
      className={capClass(form === "compact" || result)}
      role="region"
      aria-label="weir"
      ref={measureCap}
      onBlur={({ currentTarget, relatedTarget }) => {
        if (current.query === "" && !currentTarget.contains(relatedTarget)) setSearching(false);
      }}
    >
      {form !== "full" ? (
        <div
          className={
            form === "search"
              ? "flex min-w-0 items-center pt-3.5 pr-3.5 pl-7"
              : `flex h-pill min-w-0 items-center whitespace-nowrap ${result ? "pr-1.5 pl-5" : "px-1.5"}`
          }
          role={form === "compact" ? undefined : "search"}
          onMouseDown={keepFocus}
        >
          {form !== "compact" && (
            <SearchIcon className={`flex-none text-cap-2 ${result ? "mr-2" : "mr-2.5"}`} />
          )}
          <QueryField
            stepping={result ? Option.getOrNull(current.conversation) : null}
            form={form}
          />
          {result && Option.isSome(current.conversation) && (
            <HitStepper id={current.conversation.value} />
          )}
          {form !== "compact" ? (
            <button
              type="button"
              className={`ml-2 grid flex-none place-items-center rounded-circle text-cap-2 transition-tint hover:bg-cap-hover hover:text-cap-1 ${result ? "size-9" : "size-10"}`}
              aria-label="Close search"
              title="Close search"
              onClick={() => leave(undefined)}
            >
              <CloseIcon />
            </button>
          ) : (
            <>
              <span className={capDivClass} />
              <ViewStrip
                widgets={Option.match(loaded, { onNone: () => [], onSome: chips })}
                active={active}
                shown={`${active}|${Option.getOrElse(current.conversation, () => "")}`}
              />
              <span className={capDivClass} />
              {Option.isSome(loaded) && (
                <Chip widget={clearedWidget(loaded.value)} active={active} className="-ml-1" />
              )}
              <StatusButton chip alert={alert} />
            </>
          )}
        </div>
      ) : (
        <div className="py-5 pr-16 pl-7 max-wide:py-3.5 max-wide:pr-14 max-wide:pl-5">
          {Option.match(loaded, {
            onNone: () => null,
            onSome: (value) => {
              const { main, tail } = sentence(value);
              return (
                <nav aria-label="Views">
                  <p className={sentenceMainClass}>
                    {main._tag === "CaughtUp" ? (
                      <span className={allClearClass}>All caught up.</span>
                    ) : (
                      <SentenceClause clause={main.clause} active={active} />
                    )}
                  </p>
                  <p className={sentenceTailClass}>
                    {tail.map((clause) => (
                      <span key={clause[0]?.widget.kind} className="mr-em-0.3">
                        <SentenceClause clause={clause} active={active} tail />
                      </span>
                    ))}
                  </p>
                </nav>
              );
            },
          })}
          <span className="absolute top-3.5 right-3.5 flex flex-col gap-0.5 max-wide:top-2 max-wide:right-2">
            <button
              type="button"
              className={toolClass(false)}
              aria-label="Search"
              title="Search"
              onClick={() => setSearching(true)}
            >
              <SearchIcon />
            </button>
            <StatusButton chip={false} alert={alert} />
          </span>
        </div>
      )}
      {form === "search" && (
        <div className="px-7 pt-2 pb-5" aria-live="polite" onMouseDown={keepFocus}>
          <SearchSentence />
        </div>
      )}
    </div>
  );
}
