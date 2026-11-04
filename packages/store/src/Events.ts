import type { EventTime, RawEvent } from "@weir/contract/Source";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { EventChange, EventDetailRow } from "./Rows.ts";

export type EventDraft = Omit<EventDetailRow, "itemSeq">;

export type PriorEvent = Pick<
  EventDetailRow,
  "startAt" | "endAt" | "allDay" | "location" | "status"
>;

export const utcOf = (time: string, allDay: boolean): DateTime.Utc =>
  DateTime.makeUnsafe(allDay ? `${time}T00:00:00Z` : time);

const later = (time: string, allDay: boolean, millis: number) =>
  allDay
    ? DateTime.formatIsoDateUtc(DateTime.add(utcOf(time, true), { milliseconds: millis }))
    : Option.match(DateTime.makeZonedFromString(time), {
        onNone: () =>
          DateTime.formatIso(DateTime.add(utcOf(time, false), { milliseconds: millis })),
        onSome: (zoned) => DateTime.formatIsoOffset(DateTime.add(zoned, { milliseconds: millis })),
      }).replace(/\.000(?=[-+Z])/, "");

const sameInstant = (left: string, right: string, allDay: boolean) =>
  DateTime.toEpochMillis(utcOf(left, allDay)) === DateTime.toEpochMillis(utcOf(right, allDay));

const changeOf = (
  event: RawEvent,
  time: EventTime,
  prior: PriorEvent | undefined,
  live: boolean,
): EventChange | null | "unchanged" => {
  if (event.status === "cancelled") {
    if (prior?.status === "cancelled") return "unchanged";
    if (prior === undefined && event.originalStart === null && !live) return "unchanged";
    return { _tag: "Cancelled" };
  }
  if (prior !== undefined) {
    if (prior.status === "cancelled") return { _tag: "Created" };
    if (
      prior.allDay !== time.allDay ||
      !sameInstant(prior.startAt, time.start, time.allDay) ||
      !sameInstant(prior.endAt, time.end, time.allDay)
    ) {
      return { _tag: "Moved", fromStart: prior.startAt, fromEnd: prior.endAt };
    }
    if (prior.location !== event.location) {
      return { _tag: "Relocated", fromLocation: prior.location };
    }
    return "unchanged";
  }
  if (event.originalStart !== null && !sameInstant(event.originalStart, time.start, time.allDay)) {
    return {
      _tag: "Moved",
      fromStart: event.originalStart,
      fromEnd: later(
        event.originalStart,
        time.allDay,
        DateTime.toEpochMillis(utcOf(time.end, time.allDay)) -
          DateTime.toEpochMillis(utcOf(time.start, time.allDay)),
      ),
    };
  }
  return live ? { _tag: "Created" } : null;
};

export const eventDraft = (
  event: RawEvent,
  prior: PriorEvent | undefined,
  live: boolean,
): EventDraft | null => {
  const time =
    event.time ??
    (prior === undefined ? null : { start: prior.startAt, end: prior.endAt, allDay: prior.allDay });
  if (time === null) return null;
  const change = changeOf(event, time, prior, live);
  if (change === "unchanged") return null;
  return {
    eventId: event.eventId,
    seriesId: event.seriesId,
    recurring: event.recurring,
    startAt: time.start,
    endAt: time.end,
    startUtc: utcOf(time.start, time.allDay),
    endUtc: utcOf(time.end, time.allDay),
    allDay: time.allDay,
    timeZone: event.timeZone,
    location: event.status === "cancelled" && prior !== undefined ? prior.location : event.location,
    attendees: event.attendees,
    status: event.status,
    change,
  };
};
