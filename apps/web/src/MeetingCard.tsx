import { useAtomValue } from "@effect/atom-react/Hooks";
import type { EventDetail } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { attendeeLine, changeDiff, eventWhen, isCancelled, startDate } from "./Meeting.ts";
import { today, zone } from "./Weir.ts";
import { monthName } from "./When.ts";

const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function MeetingCard({
  seq,
  title,
  event,
  me,
  className,
}: {
  seq: number;
  title: string;
  event: EventDetail;
  me: boolean;
  className: string;
}) {
  const where = Option.getOrElse(useAtomValue(zone), () => browserZone);
  const date = startDate(event, where);
  const current = Option.match(useAtomValue(today), {
    onNone: () => date,
    onSome: (now) => now.date,
  });
  const diff = changeDiff(event, where);
  const cancelled = isCancelled(event);
  const people = attendeeLine(event.attendees);
  return (
    <div
      data-meeting={seq}
      className={`flex w-full max-w-em-36 min-w-0 gap-3.5 rounded-b-2xl bg-island py-3 pr-4 pl-3 text-left shadow-ring-line ${me ? "rounded-tl-2xl rounded-tr-md" : "rounded-tl-md rounded-tr-2xl"} ${className}`}
      onAnimationEnd={({ animationName, currentTarget }) => {
        if (animationName === "flash") currentTarget.removeAttribute("data-flash");
      }}
    >
      <span
        aria-hidden="true"
        className={`flex size-12 flex-none flex-col items-center justify-center rounded-xl bg-bubble ${cancelled ? "opacity-half" : ""}`}
      >
        <span className="text-2xs leading-tight font-bold tracking-wide text-ink-3 uppercase">
          {monthName(date)}
        </span>
        <b className="font-display text-xl leading-none font-bold text-ink tabular-nums">
          {Number(date.slice(8, 10))}
        </b>
      </span>
      <span className="flex min-w-0 flex-col gap-px">
        {diff !== null && (
          <span className="text-sm font-semibold text-warn tabular-nums">
            Moved: <s className="font-medium text-ink-3">{diff.from}</s> → {diff.to}
          </span>
        )}
        {cancelled && <span className="text-sm font-semibold text-warn">Cancelled</span>}
        <b
          className={`font-display text-lg leading-snug font-semibold ${cancelled ? "text-ink-3 line-through" : "text-ink"}`}
        >
          {title}
        </b>
        <span
          className={`text-sm tabular-nums ${cancelled ? "text-ink-3 line-through" : "text-ink-2"}`}
        >
          {eventWhen(event, where, current)}
          {event.recurring ? " · repeats" : ""}
        </span>
        {event.location !== null && (
          <span className="truncate text-sm text-ink-3">{event.location}</span>
        )}
        {people !== null && <span className="truncate text-sm text-ink-3">{people}</span>}
      </span>
    </div>
  );
}
