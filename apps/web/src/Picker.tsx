import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type KeyboardEvent, useState } from "react";
import { dock } from "./Reading.ts";
import type { ConversationId } from "./Route.ts";
import {
  conversation,
  type DueOverride,
  dismiss,
  type PickerTab,
  type Planned,
  picker,
  setDue,
  toast,
  today,
} from "./Weir.ts";
import {
  addDays,
  addMonths,
  clock,
  dayName,
  monthDates,
  monthDay,
  monthOf,
  monthTitle,
  parseDue,
  parseWhen,
  planText,
  slotMinutes,
  type Today,
} from "./When.ts";

export function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`flex-none fill-none stroke-current stroke-1.6 linecap-round linejoin-round ${className}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </svg>
  );
}

type Choice = {
  readonly label: string;
  readonly sub: string;
  readonly pick: () => void;
  readonly opens?: boolean;
};

type Step =
  | { readonly _tag: "List" }
  | { readonly _tag: "Month"; readonly month: string }
  | { readonly _tag: "Time"; readonly date: string };

const list: Step = { _tag: "List" };

const weekHeads = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;

const tabClass = (on: boolean) =>
  `h-7 rounded-full px-3 text-xs font-semibold transition-tint ${on ? "bg-ink text-island" : "text-ink-3 hover:bg-hover hover:text-ink"}`;

const choiceClass = (on: boolean) =>
  `grid w-full grid-cols-stream items-center gap-x-3 rounded-xl px-3 py-2 text-left transition-bg ${on ? "bg-hover" : "hover:bg-hover"}`;

const dayClass = (current: boolean) =>
  `grid h-8 place-items-center rounded-full text-sm tabular-nums transition-tint enabled:hover:bg-hover disabled:cursor-default disabled:text-ink-4 ${current ? "font-bold text-ink shadow-ring-ink-3" : "text-ink"}`;

const firstDayClass = [
  "col-start-1",
  "col-start-2",
  "col-start-3",
  "col-start-4",
  "col-start-5",
  "col-start-6",
  "col-start-7",
] as const;

const arrowClass =
  "grid size-8 place-items-center rounded-circle text-ink-3 transition-tint enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-half";

const fieldClass =
  "flex h-10 items-center gap-2.5 rounded-xl bg-hover px-3 text-ink-3 focus-within:bg-island focus-within:shadow-ring-thick-ink";

function Choices({ choices, active }: { choices: ReadonlyArray<Choice>; active: number }) {
  return (
    <div className="grid gap-px" role="listbox" aria-label="Choices">
      {choices.map((choice, at) => (
        <button
          key={choice.label}
          type="button"
          role="option"
          aria-selected={at === active}
          className={choiceClass(at === active)}
          onClick={choice.pick}
        >
          <span className="text-base font-semibold text-ink">{choice.label}</span>
          <span className="col-start-1 truncate text-sm text-ink-3">{choice.sub}</span>
          {choice.opens === true && (
            <span
              className="col-start-2 row-span-2 row-start-1 text-lg text-ink-3"
              aria-hidden="true"
            >
              ›
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Month({
  month,
  now,
  onMonth,
  onDay,
}: {
  month: string;
  now: Today;
  onMonth: (month: string) => void;
  onDay: (date: string) => void;
}) {
  const { lead, dates } = monthDates(month);
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      <div className="flex items-center justify-between pb-1">
        <button
          type="button"
          className={arrowClass}
          aria-label="Previous month"
          disabled={month <= monthOf(now.date)}
          onClick={() => onMonth(addMonths(month, -1))}
        >
          ‹
        </button>
        <span className="text-sm font-semibold text-ink">{monthTitle(month)}</span>
        <button
          type="button"
          className={arrowClass}
          aria-label="Next month"
          onClick={() => onMonth(addMonths(month, 1))}
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {weekHeads.map((head) => (
          <span key={head} className="py-1 text-2xs font-semibold text-ink-4">
            {head}
          </span>
        ))}
        {dates.map((date, at) => (
          <button
            key={date}
            type="button"
            className={`${dayClass(date === now.date)} ${at === 0 ? firstDayClass[lead] : ""}`}
            disabled={date < now.date}
            aria-label={dayName(date, now.date)}
            aria-current={date === now.date ? "date" : undefined}
            onClick={() => onDay(date)}
          >
            {Number(date.slice(8, 10))}
          </button>
        ))}
      </div>
    </div>
  );
}

const minuteOf = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours === undefined || minutes === undefined || Number.isNaN(hours + minutes)
    ? null
    : hours * 60 + minutes;
};

export function Picker({ id }: { id: ConversationId }) {
  const [open, setOpen] = useAtom(picker);
  const shown = useAtomValue(dock(id));
  const detail = useAtomValue(conversation(id));
  const current = useAtomValue(today);
  const run = useAtomSet(dismiss);
  const writeDue = useAtomSet(setDue);
  const say = useAtomSet(toast);
  const [text, setText] = useState("");
  const [step, setStep] = useState<Step>(list);
  const [active, setActive] = useState(0);
  const [time, setTime] = useState("");
  if (
    Option.isNone(open) ||
    Option.isNone(shown) ||
    Option.isNone(current) ||
    !AsyncResult.isSuccess(detail)
  ) {
    return null;
  }
  const tab = open.value.tab;
  const now = current.value;
  const { due } = detail.value.state;
  const target = shown.value.target;
  const close = () => setOpen(Option.none());
  const switchTo = (next: PickerTab) => {
    setOpen(Option.some({ id, tab: next }));
    setText("");
    setStep(list);
    setActive(0);
  };
  const commitPlan = (plan: Planned) => {
    close();
    say(Option.some(planText(plan, now.date)));
    run({ act: "Plan", target, plan });
  };
  const commitDue = (next: DueOverride) => {
    close();
    writeDue({ id, due: next });
  };
  const tomorrow = addDays(now.date, 1);
  const pickDay: Choice = {
    label: "Pick a day",
    sub: tab === "plan" ? "Any date, then a time if you like" : "Any date ahead",
    pick: () => setStep({ _tag: "Month", month: monthOf(now.date) }),
    opens: true,
  };
  const before = due === null ? null : addDays(due.date, -1);
  const choices: ReadonlyArray<Choice> =
    tab === "plan"
      ? [
          {
            label: "Later today",
            sub: "Today · any time",
            pick: () => commitPlan({ _tag: "Day", date: now.date }),
          },
          {
            label: "Tomorrow",
            sub: dayName(tomorrow, now.date),
            pick: () => commitPlan({ _tag: "Day", date: tomorrow }),
          },
          ...(due !== null && before !== null && before > now.date
            ? [
                {
                  label: "Day before it's due",
                  sub: `${dayName(before, now.date)} · due ${monthDay(due.date, now.date)}`,
                  pick: () => commitPlan({ _tag: "Day", date: before }),
                },
              ]
            : []),
          { label: "Tray", sub: "No date yet", pick: () => commitPlan({ _tag: "Tray" }) },
          pickDay,
        ]
      : [
          {
            label: "Today",
            sub: dayName(now.date, now.date),
            pick: () => commitDue({ _tag: "Date", date: now.date }),
          },
          {
            label: "Tomorrow",
            sub: dayName(tomorrow, now.date),
            pick: () => commitDue({ _tag: "Date", date: tomorrow }),
          },
          pickDay,
          ...(due === null
            ? []
            : [
                {
                  label: "Remove due date",
                  sub: `Due ${monthDay(due.date, now.date)} now`,
                  pick: () => commitDue({ _tag: "Cleared" }),
                },
              ]),
        ];
  const typed =
    tab === "plan"
      ? Option.map(Option.fromNullishOr(parseWhen(text, now)), (parsed) =>
          parsed._tag === "Ok"
            ? { ok: true, line: parsed.preview, commit: () => commitPlan(parsed.value) }
            : { ok: false, line: parsed.why, commit: () => undefined },
        )
      : Option.map(Option.fromNullishOr(parseDue(text, now)), (parsed) =>
          parsed._tag === "Ok"
            ? {
                ok: true,
                line: parsed.preview,
                commit: () => commitDue({ _tag: "Date", date: parsed.value }),
              }
            : { ok: false, line: parsed.why, commit: () => undefined },
        );
  const slotAt = step._tag === "Time" ? minuteOf(time) : null;
  const slotOk =
    step._tag === "Time" && slotAt !== null && (step.date > now.date || slotAt >= now.minute);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") return;
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (step._tag === "List") close();
      else setStep(step._tag === "Time" ? { _tag: "Month", month: monthOf(step.date) } : list);
      return;
    }
    if (step._tag !== "List") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      Option.match(typed, {
        onNone: () => choices[active]?.pick(),
        onSome: ({ commit }) => commit(),
      });
    }
  };
  return (
    <div
      className="absolute inset-x-0 bottom-picker z-dock mx-auto flex max-h-picker w-picker max-w-dock flex-col gap-1 overflow-y-auto rounded-3xl bg-island p-2 elevation-float max-wide:bottom-picker-safe"
      role="dialog"
      aria-label={tab === "plan" ? "Plan this conversation" : "Set a due date"}
      tabIndex={-1}
      data-picker=""
      onKeyDown={onKeyDown}
      onBlur={({ currentTarget, relatedTarget }) => {
        if (!currentTarget.contains(relatedTarget)) close();
      }}
    >
      <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1">
        <div className="flex gap-0.5" role="tablist">
          {(["plan", "due"] as const).map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={tab === each}
              className={tabClass(tab === each)}
              onClick={() => switchTo(each)}
            >
              {each === "plan" ? "Plan" : "Due"}
            </button>
          ))}
        </div>
        <span className="text-2xs font-medium text-ink-4">↑↓ Enter · Esc</span>
      </div>
      {step._tag === "List" && (
        <>
          <label className={fieldClass}>
            <CalendarIcon className="size-4" />
            <input
              ref={(input) => input?.focus({ preventScroll: true })}
              type="text"
              className="min-w-0 flex-1 border-none bg-transparent p-0 font-sans text-base text-ink outline-none placeholder:text-ink-4"
              spellCheck={false}
              autoComplete="off"
              enterKeyHint="done"
              aria-label={tab === "plan" ? "Type a time" : "Type a date"}
              placeholder={
                tab === "plan" ? "thu 3pm, nov 12, in 2 weeks" : "fri, nov 12, in 2 weeks"
              }
              value={text}
              onChange={({ currentTarget }) => setText(currentTarget.value)}
            />
          </label>
          {Option.isSome(typed) && (
            <p
              className={`m-0 px-3 pb-1 text-sm ${typed.value.ok ? "font-semibold text-ink" : "text-ink-3"}`}
              aria-live="polite"
            >
              {typed.value.line}
            </p>
          )}
          <Choices choices={choices} active={active} />
        </>
      )}
      {step._tag === "Month" && (
        <Month
          month={step.month}
          now={now}
          onMonth={(month) => setStep({ _tag: "Month", month })}
          onDay={(date) =>
            tab === "plan" ? setStep({ _tag: "Time", date }) : commitDue({ _tag: "Date", date })
          }
        />
      )}
      {step._tag === "Time" && (
        <div className="grid gap-1">
          <button
            type="button"
            className={choiceClass(false)}
            onClick={() => setStep({ _tag: "Month", month: monthOf(step.date) })}
          >
            <span className="text-base font-semibold text-ink">
              ‹ {dayName(step.date, now.date)}
            </span>
          </button>
          <Choices
            choices={[
              {
                label: "Any time",
                sub: "That day, no set time",
                pick: () => commitPlan({ _tag: "Day", date: step.date }),
              },
            ]}
            active={-1}
          />
          <form
            className="flex items-center gap-2 px-1.5 pb-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (slotOk && slotAt !== null) {
                commitPlan({ _tag: "Slot", date: step.date, start: slotAt, minutes: slotMinutes });
              }
            }}
          >
            <label className={`${fieldClass} flex-1`}>
              <span className="text-sm">At</span>
              <input
                type="time"
                className="min-w-0 flex-1 border-none bg-transparent p-0 font-sans text-base text-ink tabular-nums outline-none"
                aria-label="Time"
                value={time}
                onChange={({ currentTarget }) => setTime(currentTarget.value)}
              />
            </label>
            <button
              type="submit"
              className="h-10 rounded-full bg-capbg px-4 text-sm font-semibold text-cap-1 transition-press-bg hover:bg-primary-hover active:scale-press disabled:opacity-half"
              disabled={!slotOk}
            >
              {slotOk && slotAt !== null ? `Set ${clock(slotAt)}` : "Set"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export function Toast() {
  const [shown, setShown] = useAtom(toast);
  if (Option.isNone(shown)) return null;
  const { text, key } = shown.value;
  return (
    <div className="pointer-events-none fixed bottom-toast left-reader z-dock flex w-reader justify-center max-wide:inset-x-0 max-wide:bottom-picker-safe max-wide:w-auto">
      <p
        key={key}
        className="m-0 rounded-full bg-capbg px-4 py-2.5 text-sm font-semibold text-cap-1 elevation-float"
        role="status"
        data-toast=""
        onAnimationEnd={({ target, currentTarget }) => {
          if (target === currentTarget) setShown(Option.none());
        }}
      >
        {text}
      </p>
    </div>
  );
}
