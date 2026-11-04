import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import {
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { Link } from "./Link.tsx";
import { dueFlagClass } from "./ListClasses.ts";
import {
  type Block,
  carriedLabel,
  type DatedRow,
  datedOn,
  dayBlocks,
  dayMinutes,
  dayPlanMinutes,
  inMonth,
  monthEntries,
  monthGrid,
  movedStart,
  type PlannedRow,
  resizedMinutes,
  scrollMinute,
  stepped,
  toDay,
  trayAge,
  trayRows,
} from "./PlanLayout.ts";
import { ConversationId, type Route, route, type Scale } from "./Route.ts";
import { clockNow, dismiss, planList, planRows, today } from "./Weir.ts";
import {
  clock,
  daysBetween,
  dueFlag,
  monthOf,
  monthTitle,
  type Planned,
  type Today,
} from "./When.ts";

type Source = "tray" | "block" | "chip";

type Drag = {
  readonly row: PlannedRow;
  readonly kind: "move" | "resize";
  readonly source: Source;
  readonly x: number;
  readonly y: number;
  readonly start: number;
  readonly offset: number;
  readonly dx: number;
  readonly dy: number;
  readonly moved: boolean;
  readonly over: string | null;
  readonly plan: Planned | null;
};
type Grab = (
  event: PointerEvent<HTMLElement>,
  row: PlannedRow,
  source: Source,
  kind?: "move" | "resize",
  block?: { readonly start: number; readonly offset: number },
) => void;

type Hands = {
  readonly drag: Drag | null;
  readonly grab: Grab;
};

const dragThreshold = 4;
const scrollPad = 12;

const longDay = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const dayLong = (date: string) => longDay.format(Date.parse(date));

const relative = (date: string, at: string) => {
  const ahead = daysBetween(at, date);
  return ahead === 0
    ? "Today"
    : ahead === 1
      ? "Tomorrow"
      : ahead === -1
        ? "Yesterday"
        : ahead > 0
          ? `In ${ahead} days`
          : `${-ahead} days ago`;
};

const hit = (drag: Drag, x: number, y: number, date: string) => {
  const target = document
    .elementsFromPoint(x, y)
    .find((el): el is HTMLElement => el instanceof HTMLElement && el.dataset.drop !== undefined);
  const key = target?.dataset.drop;
  if (target === undefined || key === undefined) return { over: null, plan: null };
  if (drag.kind === "resize" && !key.startsWith("slot:")) return { over: null, plan: null };
  const [kind, day = ""] = key.split(":");
  if (kind === "tray") return { over: key, plan: { _tag: "Tray" } satisfies Planned };
  if (kind === "day") return { over: key, plan: toDay(drag.row, day, date) };
  const box = target.getBoundingClientRect();
  const minute = ((y - box.top) / box.height) * dayMinutes;
  if (drag.kind === "resize") {
    return {
      over: key,
      plan: {
        _tag: "Slot",
        date: day,
        start: drag.start,
        minutes: resizedMinutes(drag.start, minute),
      } satisfies Planned,
    };
  }
  const minutes =
    drag.row.plan._tag === "Slot" && drag.source === "block" && drag.row.plan.date >= date
      ? drag.row.plan.minutes
      : dayPlanMinutes;
  return {
    over: key,
    plan: {
      _tag: "Slot",
      date: day,
      start: movedStart(minute - drag.offset, minutes),
      minutes,
    } satisfies Planned,
  };
};

const useHands = (date: string): Hands => {
  const [drag, setDrag] = useState<Drag | null>(null);
  const run = useAtomSet(dismiss);
  return {
    drag,
    grab: (event, row, source, kind = "move", block) => {
      if (event.button !== 0 || !matchMedia("(min-width: 900px)").matches) return;
      event.stopPropagation();
      let current: Drag = {
        row,
        kind,
        source,
        x: event.clientX,
        y: event.clientY,
        start: block?.start ?? 0,
        offset: block?.offset ?? 0,
        dx: 0,
        dy: 0,
        moved: false,
        over: null,
        plan: null,
      };
      const update = (next: Drag) => {
        current = next;
        setDrag(next);
      };
      const stop = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", drop);
        removeEventListener("pointercancel", stop);
        setDrag(null);
      };
      const move = (moved: globalThis.PointerEvent) => {
        const dx = moved.clientX - current.x;
        const dy = moved.clientY - current.y;
        if (!current.moved && Math.hypot(dx, dy) < dragThreshold) return;
        update({
          ...current,
          dx,
          dy,
          moved: true,
          ...hit(current, moved.clientX, moved.clientY, date),
        });
      };
      const drop = (up: globalThis.PointerEvent) => {
        stop();
        if (!current.moved) return;
        dragged.at = up.timeStamp;
        const { plan } = current;
        if (plan !== null && JSON.stringify(plan) !== JSON.stringify(current.row.plan)) {
          run({ act: "Plan", target: current.row, plan });
        }
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", drop);
      addEventListener("pointercancel", stop);
      setDrag(current);
    },
  };
};

const dragged = { at: -1 };

const handlers = {
  onClickCapture: (event: MouseEvent) => {
    if (event.timeStamp - dragged.at > 500) return;
    event.preventDefault();
    event.stopPropagation();
  },
  onDragStart: (event: MouseEvent) => event.preventDefault(),
};

const lifted = (hands: Hands, id: number, inPlace: boolean) => {
  const drag = hands.drag;
  if (drag === null || drag.row.id !== id || !drag.moved || inPlace) return {};
  return {
    "data-dragging": "",
    style: { "--dx": `${drag.dx}px`, "--dy": `${drag.dy}px` } as CSSProperties,
  };
};

const openRoute = (at: Route, id: number): Route => ({
  ...at,
  conversation: Option.some(ConversationId.make(id)),
});

const flagClass =
  "inline-flex h-5 items-center rounded-full bg-hover px-2 text-2xs font-semibold text-ink-2";

function Flags({ row, date }: { row: PlannedRow; date: string }) {
  const due = row.due === null ? null : dueFlag(row.due.date, date);
  if (due === null && row.new === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {due !== null && <span className={dueFlagClass(due.over)}>{due.text}</span>}
      {row.new > 0 && <span className={flagClass}>{row.new} new</span>}
    </span>
  );
}

export function PlanCard({
  row,
  to,
  date,
  nowMs,
  selected,
  grab,
}: {
  row: PlannedRow;
  to: Route;
  date: string;
  nowMs: number;
  selected: boolean;
  grab?: Grab;
}) {
  const sender = row.from.me ? "Me" : row.from.name.trim() || row.from.address;
  return (
    <article
      data-k={row.id}
      className={`relative flex-none rounded-2xl bg-island transition-tint-ring select-none ${selected ? "shadow-ring-thick-ink" : "elevation-row"}`}
      onPointerDown={grab === undefined ? undefined : (event) => grab(event, row, "tray")}
    >
      <Link
        origin="active"
        to={to}
        current={selected}
        className="grid gap-1 rounded-2xl px-3.5 py-3 text-ink no-underline"
      >
        <span className="text-2xs font-semibold text-ink-3">{trayAge(row.planned_at, nowMs)}</span>
        <span className="line-clamp-2 text-md leading-snug font-semibold">{row.title}</span>
        <span className="truncate text-xs text-ink-3">
          {sender} · {row.source}
        </span>
        <Flags row={row} date={date} />
      </Link>
    </article>
  );
}

function Tray({
  rows,
  at,
  date,
  hands,
}: {
  rows: ReadonlyArray<PlannedRow>;
  at: Route;
  date: string;
  hands: Hands;
}) {
  const nowMs = Option.getOrElse(useAtomValue(clockNow), () => 0);
  const tray = trayRows(rows);
  const open = Option.getOrNull(at.conversation);
  return (
    <aside
      className={`flex min-h-0 flex-none flex-col gap-2 rounded-3xl p-3 transition-bg @plan:mb-4 @plan:bg-hover ${hands.drag?.over === "tray" ? "bg-g-hover" : ""}`}
      data-drop="tray"
      aria-label="Tray"
    >
      <header className="flex items-baseline gap-2 px-1">
        <h2 className="m-0 font-display text-lg font-extrabold tracking-tight text-ink">Tray</h2>
        <span className="text-sm font-semibold text-ink-3 tabular-nums">{tray.length}</span>
      </header>
      <p className="m-0 hidden px-1 text-xs leading-snug text-ink-3 @plan:block">
        {tray.length === 0
          ? "Empty. Plan something without a date and it waits here."
          : "No date yet. Oldest first, nothing leaves on its own. Drag a card onto the day."}
      </p>
      {tray.length > 0 && (
        <div className="-mx-3 flex gap-2 overflow-x-auto overscroll-x-contain px-3 pb-1 scrollbar-none @plan:mx-0 @plan:flex-col @plan:overflow-x-visible @plan:overflow-y-auto @plan:px-0 @plan:scrollbar-thin">
          {tray.map((row) => (
            <div
              key={row.id}
              className="w-card flex-none @plan:w-auto"
              {...handlers}
              {...lifted(hands, row.id, false)}
            >
              <PlanCard
                row={row}
                to={openRoute(at, row.id)}
                date={date}
                nowMs={nowMs}
                selected={open === row.id}
                grab={hands.grab}
              />
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

const headingClass =
  "m-0 font-display text-3xl leading-tight font-extrabold tracking-tight text-balance text-ink max-wide:text-2xl";
const eyebrowClass = "m-0 mb-1 text-xs font-semibold text-ink-3";
const softClass = "text-ink-4";

function DayHeading({
  rows,
  date,
  now: at,
}: {
  rows: ReadonlyArray<PlannedRow>;
  date: string;
  now: Today;
}) {
  const on = datedOn(rows, date, at.date);
  const carried = on.filter((row) => row.plan.date < at.date).length;
  return (
    <header className="px-1 pt-2 pb-4">
      <p className={eyebrowClass}>{relative(date, at.date)}</p>
      <h1 className={headingClass}>
        {dayLong(date)}.{" "}
        {on.length === 0 ? (
          <span className={softClass}>Nothing planned.</span>
        ) : (
          <>
            {on.length}
            <span className={softClass}> planned</span>
            {carried > 0 && (
              <>
                <span className={softClass}>, </span>
                {carried}
                <span className={softClass}> carried over</span>
              </>
            )}
            <span className={softClass}>.</span>
          </>
        )}
      </h1>
      {date === at.date && (
        <p className="m-0 mt-1.5 text-sm text-ink-3">It's {clock(at.minute)}.</p>
      )}
      {date < at.date && (
        <p className="m-0 mt-1.5 text-sm text-ink-3">
          This day is behind you. Anything left on it moved to today.
        </p>
      )}
    </header>
  );
}

function PlanBlock({
  block,
  at,
  date,
  selected,
  hands,
  inPlace,
}: {
  block: Block;
  at: Route;
  date: string;
  selected: boolean;
  hands: Hands;
  inPlace: boolean;
}) {
  const { row, start, minutes, solid, from, lane, lanes } = block;
  const lift = lifted(hands, row.id, inPlace);
  const short = minutes < 45;
  return (
    <article
      data-k={row.id}
      data-dragging={lift["data-dragging"]}
      className={`absolute top-slot left-lane h-slot w-lane overflow-hidden rounded-lg text-xs leading-tight select-none data-dragging:elevation-float ${solid ? "bg-capbg text-cap-1" : "border border-dashed border-ink-4 bg-island text-ink"} ${selected ? "shadow-ring-thick-ink" : ""}`}
      style={
        {
          "--start": start,
          "--span": minutes,
          "--lane": lane,
          "--lanes": lanes,
          ...lift.style,
        } as CSSProperties
      }
      onPointerDown={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        hands.grab(event, row, "block", "move", {
          start,
          offset: ((event.clientY - box.top) / box.height) * minutes,
        });
      }}
      {...handlers}
    >
      <Link
        origin="active"
        to={openRoute(at, row.id)}
        current={selected}
        className={`flex h-full min-w-0 gap-x-2 px-2 py-1 no-underline ${short ? "items-center" : "flex-col"} ${solid ? "text-cap-1" : "text-ink"}`}
      >
        <span
          className={`flex flex-none items-center gap-1.5 tabular-nums ${solid ? "text-cap-2" : "text-ink-3"}`}
        >
          <time>
            {clock(start)}–{clock(start + minutes)}
          </time>
          {!solid && (
            <span className="rounded-full bg-hover px-1.5 font-semibold text-ink-2">
              {from === null ? "any time" : carriedLabel(from, date)}
            </span>
          )}
        </span>
        <span className="min-w-0 truncate font-semibold">{row.title}</span>
        {row.new > 0 && (
          <span
            className={`flex-none self-start rounded-full px-1.5 font-semibold ${solid ? "bg-cap-hover text-cap-1" : "bg-hover text-ink-2"}`}
          >
            {row.new} new
          </span>
        )}
      </Link>
      {solid && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          onPointerDown={(event) => hands.grab(event, row, "block", "resize", { start, offset: 0 })}
        />
      )}
    </article>
  );
}

const hours = Array.from({ length: 24 }, (_, hour) => hour);

function DayTimeline({
  rows,
  at,
  date,
  now: current,
  hands,
}: {
  rows: ReadonlyArray<PlannedRow>;
  at: Route;
  date: string;
  now: Today;
  hands: Hands;
}) {
  const drag = hands.drag;
  const preview =
    drag?.moved === true && drag.plan?._tag === "Slot" && drag.plan.date === date
      ? drag.plan
      : null;
  const inPlace = preview !== null && drag?.source === "block";
  const shown =
    inPlace && preview !== null && drag !== null
      ? rows.map((row) => (row.id === drag.row.id ? { ...row, plan: preview } : row))
      : rows;
  const blocks = dayBlocks(shown, date, current);
  const open = Option.getOrNull(at.conversation);
  const mark = scrollMinute(date, current);
  const scrollTo = useCallback((scroller: HTMLDivElement | null) => {
    const target = scroller?.querySelector<HTMLElement>("[data-mark]");
    if (scroller == null || target == null) return;
    scroller.scrollTop =
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop -
      scrollPad;
  }, []);
  return (
    <div
      key={date}
      ref={scrollTo}
      className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-thin"
      aria-label={`Timeline for ${dayLong(date)}`}
    >
      <div className="plan-hours relative mr-1 ml-hours h-day" data-drop={`slot:${date}`}>
        <span
          data-mark=""
          className="absolute top-slot"
          style={{ "--start": mark } as CSSProperties}
        />
        {hours.map((hour) => (
          <span
            key={hour}
            aria-hidden="true"
            className="absolute top-slot right-full -mt-2 w-hours pr-2 text-right text-2xs font-medium text-ink-3 tabular-nums"
            style={{ "--start": hour * 60 } as CSSProperties}
          >
            {clock(hour * 60)}
          </span>
        ))}
        {date === current.date && (
          <span
            className="absolute top-slot inset-x-0 z-raised h-px bg-ok"
            style={{ "--start": current.minute } as CSSProperties}
            aria-label={`Now, ${clock(current.minute)}`}
          />
        )}
        {blocks.map((block) => (
          <PlanBlock
            key={block.row.id}
            block={block}
            at={at}
            date={date}
            selected={open === block.row.id}
            hands={hands}
            inPlace={inPlace && drag?.row.id === block.row.id}
          />
        ))}
        {preview !== null && !inPlace && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-slot left-lane h-slot w-lane rounded-lg border border-dashed border-ink-3 bg-hover px-2 py-1 text-xs font-semibold text-ink-2 tabular-nums"
            style={
              {
                "--start": preview.start,
                "--span": preview.minutes,
                "--lane": 0,
                "--lanes": 1,
              } as CSSProperties
            }
          >
            {clock(preview.start)}–{clock(preview.start + preview.minutes)}
          </span>
        )}
      </div>
    </div>
  );
}

const weekHeads = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function MonthHeading({
  rows,
  month,
  now: at,
}: {
  rows: ReadonlyArray<PlannedRow>;
  month: string;
  now: Today;
}) {
  const count = inMonth(rows, month, at.date).length;
  return (
    <header className="px-1 pt-2 pb-4">
      <p className={eyebrowClass}>
        {month === monthOf(at.date) ? "This month" : monthTitle(month)}
      </p>
      <h1 className={headingClass}>
        {monthTitle(month)}.{" "}
        {count === 0 ? (
          <span className={softClass}>Nothing planned.</span>
        ) : (
          <>
            {count}
            <span className={softClass}> planned.</span>
          </>
        )}
      </h1>
    </header>
  );
}

function MonthChip({
  row,
  at,
  date,
  hands,
  selected,
}: {
  row: DatedRow;
  at: Route;
  date: string;
  hands: Hands;
  selected: boolean;
}) {
  const solid = row.plan._tag === "Slot" && row.plan.date >= date;
  return (
    <li
      className={`min-w-0 overflow-hidden rounded-md select-none data-dragging:elevation-float ${solid ? "bg-capbg text-cap-1" : "border border-dashed border-ink-4 bg-island text-ink"} ${selected ? "shadow-ring-thick-ink" : ""}`}
      onPointerDown={(event) => hands.grab(event, row, "chip")}
      {...handlers}
      {...lifted(hands, row.id, false)}
    >
      <Link
        origin="active"
        to={openRoute(at, row.id)}
        current={selected}
        className={`flex h-5 min-w-0 items-center gap-1 px-1.5 text-2xs font-semibold no-underline max-wide:px-1 ${solid ? "text-cap-1" : "text-ink"}`}
      >
        {solid && row.plan._tag === "Slot" && (
          <time className="flex-none text-cap-2 tabular-nums max-wide:hidden">
            {clock(row.plan.start)}
          </time>
        )}
        <span className="min-w-0 truncate">{row.title}</span>
        {row.new > 0 && (
          <span className="size-1.5 flex-none rounded-circle bg-ok" aria-label={`${row.new} new`} />
        )}
      </Link>
    </li>
  );
}

function MonthGrid({
  rows,
  at,
  month,
  now: current,
  hands,
}: {
  rows: ReadonlyArray<PlannedRow>;
  at: Route;
  month: string;
  now: Today;
  hands: Hands;
}) {
  const [, navigate] = useAtom(route);
  const open = Option.getOrNull(at.conversation);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4 scrollbar-thin">
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label={monthTitle(month)}>
        {weekHeads.map((head) => (
          <span
            key={head}
            role="columnheader"
            className="px-1.5 pb-1 text-2xs font-semibold text-ink-3"
          >
            {head}
          </span>
        ))}
        {monthGrid(month).map((date) => {
          const entries = monthEntries(rows, date, current.date);
          const shown = entries.slice(0, 3);
          const key = `day:${date}`;
          return (
            <div
              key={date}
              role="gridcell"
              data-drop={key}
              data-over={hands.drag?.over === key || undefined}
              aria-label={`${dayLong(date)}, ${entries.length} planned`}
              className={`flex min-h-cell min-w-0 flex-col gap-1 rounded-xl p-1.5 transition-bg data-over:bg-g-hover max-wide:min-h-cell-sm max-wide:p-1 ${monthOf(date) === month ? "bg-hover" : "opacity-half"}`}
            >
              <button
                type="button"
                className={`grid size-6 place-items-center rounded-circle text-xs font-semibold tabular-nums transition-tint hover:bg-g-hover ${date === current.date ? "bg-ink text-island hover:bg-ink" : date < current.date ? "text-ink-4" : "text-ink-2"}`}
                aria-label={`Open ${dayLong(date)}`}
                onClick={() =>
                  navigate({
                    _tag: "Go",
                    to: {
                      ...at,
                      scale: "day",
                      date: date === current.date ? Option.none() : Option.some(date),
                    },
                    origin: "passive",
                  })
                }
              >
                {Number(date.slice(8, 10))}
              </button>
              {shown.length > 0 && (
                <ul className="m-0 flex min-w-0 list-none flex-col gap-0.5 p-0">
                  {shown.map((row) => (
                    <MonthChip
                      key={row.id}
                      row={row}
                      at={at}
                      date={current.date}
                      hands={hands}
                      selected={open === row.id}
                    />
                  ))}
                </ul>
              )}
              {entries.length > shown.length && (
                <span className="px-1 text-2xs font-semibold text-ink-3">
                  +{entries.length - shown.length} more
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const segmentClass = (on: boolean) =>
  `h-8 rounded-full px-3.5 text-sm font-semibold transition-tint ${on ? "bg-ink text-island" : "text-ink-3 hover:text-ink"}`;

const navClass =
  "grid size-8 place-items-center rounded-circle text-lg text-ink-2 transition-tint hover:bg-g-hover hover:text-ink";

function PlanBar({ at, date, now: current }: { at: Route; date: string; now: Today }) {
  const [, navigate] = useAtom(route);
  const go = (to: Route) => navigate({ _tag: "Go", to, origin: "passive" });
  const step = (by: 1 | -1) => {
    const next = stepped(at.scale, date, by);
    go({ ...at, date: next === current.date ? Option.none() : Option.some(next) });
  };
  const unit = at.scale === "day" ? "day" : "month";
  const scales: ReadonlyArray<readonly [Scale, string, string]> = [
    ["day", "Day", "d"],
    ["month", "Month", "m"],
  ];
  return (
    <nav
      aria-label="Plan"
      className="flex h-band flex-none items-center gap-3 px-2.5 max-wide:h-auto max-wide:justify-between max-wide:px-1 max-wide:pb-2"
    >
      <div className="flex rounded-full bg-hover p-0.5" role="tablist" aria-label="Calendar scale">
        {scales.map(([scale, label, key]) => (
          <button
            key={scale}
            type="button"
            role="tab"
            aria-selected={at.scale === scale}
            aria-keyshortcuts={key}
            title={`${label} (${key})`}
            className={segmentClass(at.scale === scale)}
            onClick={() => go({ ...at, scale })}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-0.5 rounded-full bg-hover p-0.5">
        <button
          type="button"
          className={navClass}
          aria-label={`Previous ${unit}`}
          aria-keyshortcuts="ArrowLeft"
          title={`Previous ${unit} (←)`}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="h-8 rounded-full px-3 text-sm font-semibold text-ink-2 transition-tint enabled:hover:bg-g-hover enabled:hover:text-ink disabled:text-ink-4"
          aria-keyshortcuts="t"
          title="Today (t)"
          disabled={Option.isNone(at.date)}
          onClick={() => go({ ...at, date: Option.none() })}
        >
          Today
        </button>
        <button
          type="button"
          className={navClass}
          aria-label={`Next ${unit}`}
          aria-keyshortcuts="ArrowRight"
          title={`Next ${unit} (→)`}
          onClick={() => step(1)}
        >
          ›
        </button>
      </div>
    </nav>
  );
}

function Shell({ reading, children }: { reading: boolean; children: ReactNode }) {
  return (
    <main
      className={`plan @container fixed top-edge bottom-edge left-stage flex flex-col overflow-hidden rounded-reader bg-island elevation-reader max-wide:top-list max-wide:right-0 max-wide:bottom-0 max-wide:left-0 max-wide:w-auto max-wide:rounded-none max-wide:bg-ground max-wide:px-2 max-wide:shadow-none ${reading ? "w-list" : "w-stage"}`}
      aria-label="Plan"
    >
      {children}
    </main>
  );
}

export function PlanView() {
  const [at] = useAtom(route);
  const current = useAtomValue(today);
  const rows = useAtomValue(planRows);
  const loaded = !AsyncResult.isInitial(useAtomValue(planList));
  const date = Option.getOrElse(at.date, () =>
    Option.match(current, { onNone: () => "", onSome: ({ date: day }) => day }),
  );
  const hands = useHands(
    Option.match(current, { onNone: () => "", onSome: ({ date: day }) => day }),
  );
  const reading = Option.isSome(at.conversation);
  if (Option.isNone(current) || date === "") return <Shell reading={reading}>{null}</Shell>;
  const month = monthOf(date);
  return (
    <Shell reading={reading}>
      <PlanBar at={at} date={date} now={current.value} />
      <div
        className={`flex min-h-0 flex-1 flex-col gap-2 px-6 max-wide:px-0 @plan:grid @plan:grid-cols-plan @plan:gap-6 ${loaded ? "" : "opacity-none"}`}
      >
        <section className="order-2 flex min-h-0 flex-1 flex-col @plan:order-1">
          {at.scale === "day" ? (
            <>
              <DayHeading rows={rows} date={date} now={current.value} />
              <DayTimeline rows={rows} at={at} date={date} now={current.value} hands={hands} />
            </>
          ) : (
            <>
              <MonthHeading rows={rows} month={month} now={current.value} />
              <MonthGrid rows={rows} at={at} month={month} now={current.value} hands={hands} />
            </>
          )}
        </section>
        <div className="order-1 min-h-0 @plan:order-2 @plan:flex @plan:flex-col @plan:pt-2">
          <Tray rows={rows} at={at} date={current.value.date} hands={hands} />
        </div>
      </div>
    </Shell>
  );
}
