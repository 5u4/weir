import type { EventTime, RawEvent } from "@weir/contract/Source";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { EventChange, EventDetailRow, EventOccurrenceRow, Seq } from "./Rows.ts";

export type EventDraft = Omit<EventDetailRow, "itemSeq">;

export interface EventPriors {
  readonly details: ReadonlyMap<string, EventDetailRow>;
  readonly occurrences: ReadonlyMap<string, EventOccurrenceRow>;
}

export const noPriors: EventPriors = { details: new Map(), occurrences: new Map() };

export type EventOutcome =
  | { readonly _tag: "Item"; readonly event: EventDraft }
  | { readonly _tag: "Refresh"; readonly itemSeq: Seq; readonly event: EventDraft };

type PriorEvent = Omit<EventDetailRow, "itemSeq" | "eventId" | "change">;

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

const scheduledOf = (event: RawEvent, priors: EventPriors): PriorEvent | undefined => {
  const master = event.seriesId === null ? undefined : priors.details.get(event.seriesId);
  const shared = {
    seriesId: event.seriesId,
    recurring: false,
    timeZone: master?.timeZone ?? null,
    location: master?.location ?? null,
    attendees: master?.attendees ?? [],
  };
  const occurrence = priors.occurrences.get(event.eventId);
  if (occurrence !== undefined) {
    return {
      ...shared,
      startAt: occurrence.startAt,
      endAt: occurrence.endAt,
      startUtc: occurrence.startUtc,
      endUtc: occurrence.endUtc,
      allDay: occurrence.allDay,
      status: occurrence.status,
    };
  }
  if (event.originalStart === null || master === undefined) return undefined;
  const endAt = later(
    event.originalStart,
    master.allDay,
    DateTime.toEpochMillis(master.endUtc) - DateTime.toEpochMillis(master.startUtc),
  );
  return {
    ...shared,
    startAt: event.originalStart,
    endAt,
    startUtc: utcOf(event.originalStart, master.allDay),
    endUtc: utcOf(endAt, master.allDay),
    allDay: master.allDay,
    status: "confirmed",
  };
};

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
  priors: EventPriors,
  live: boolean,
): EventOutcome | null => {
  const cancelled = event.status === "cancelled";
  const detail = priors.details.get(event.eventId);
  const prior = detail ?? (cancelled ? scheduledOf(event, priors) : undefined);
  const time =
    event.time ??
    (prior === undefined ? null : { start: prior.startAt, end: prior.endAt, allDay: prior.allDay });
  if (time === null) return null;
  const change = changeOf(event, time, prior, live);
  const sparse = cancelled && prior !== undefined ? prior : undefined;
  const draft = {
    eventId: event.eventId,
    seriesId: event.seriesId ?? sparse?.seriesId ?? null,
    recurring: event.recurring || (sparse?.recurring ?? false),
    startAt: time.start,
    endAt: time.end,
    startUtc: utcOf(time.start, time.allDay),
    endUtc: utcOf(time.end, time.allDay),
    allDay: time.allDay,
    timeZone: event.timeZone ?? sparse?.timeZone ?? null,
    location: sparse === undefined ? event.location : sparse.location,
    attendees:
      sparse !== undefined && event.attendees.length === 0 ? sparse.attendees : event.attendees,
    status: event.status,
  };
  if (change !== "unchanged") return { _tag: "Item", event: { ...draft, change } };
  if (detail === undefined) return null;
  return { _tag: "Refresh", itemSeq: detail.itemSeq, event: { ...draft, change: detail.change } };
};
