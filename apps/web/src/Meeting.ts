import type { Attendee, EventDetail } from "@weir/daemon/Api";
import { addDays, clock, dayName, monthDay, weekdayName, zonedAt } from "./When.ts";

export type Diff = { readonly from: string; readonly to: string };

const isDate = (value: string) => value.length === 10;

const moment = (value: string, zone: string) => {
  if (isDate(value)) return dayName(value, value);
  const at = zonedAt(Date.parse(value), zone);
  return `${weekdayName(at.date)} ${clock(at.minute)}`;
};

const nowhere = "no place";

export const changeDiff = (event: EventDetail, zone: string): Diff | null => {
  const change = event.change;
  if (change === null) return null;
  switch (change._tag) {
    case "Moved":
      return { from: moment(change.from_start, zone), to: moment(event.start, zone) };
    case "Relocated":
      return { from: change.from_location ?? nowhere, to: event.location ?? nowhere };
    case "Created":
    case "Cancelled":
      return null;
  }
};

export const isCancelled = (event: Pick<EventDetail, "status" | "change">) =>
  event.status === "cancelled" || event.change?._tag === "Cancelled";

export const startDate = (event: Pick<EventDetail, "start">, zone: string) =>
  isDate(event.start) ? event.start : zonedAt(Date.parse(event.start), zone).date;

export const eventWhen = (
  event: Pick<EventDetail, "start" | "end" | "all_day">,
  zone: string,
  today: string,
) => {
  if (event.all_day) {
    const last = addDays(event.end, -1);
    return last > event.start
      ? `${monthDay(event.start, today)} – ${monthDay(last, today)} · all day`
      : `${dayName(event.start, today)} · all day`;
  }
  const from = zonedAt(Date.parse(event.start), zone);
  const to = zonedAt(Date.parse(event.end), zone);
  return from.date === to.date
    ? `${dayName(from.date, today)} · ${clock(from.minute)}–${clock(to.minute)}`
    : `${dayName(from.date, today)} ${clock(from.minute)} – ${dayName(to.date, today)} ${clock(to.minute)}`;
};

const shownPeople = 3;

export const attendeeLine = (attendees: ReadonlyArray<Attendee>) => {
  if (attendees.length === 0) return null;
  const names = attendees
    .slice(0, shownPeople)
    .map(({ name, email }) => name?.trim() || (email.split("@")[0] ?? email));
  const more = attendees.length - names.length;
  return `with ${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};
