import type {
  EventTime,
  Occurrence,
  RawItem,
  SeriesOccurrences,
  SyncPage,
} from "@weir/contract/Source";
import * as Schema from "effect/Schema";
import {
  type CalendarEvent,
  type EventDateTime,
  type Gws,
  GwsError,
  listEvents,
  listInstances,
} from "./gws.ts";
import { htmlBody, htmlBodyNew } from "./markdown.ts";

export const calendarPrefix = "calendar/";

const DAY_MS = 86_400_000;
const PAST_DAYS = 35;
const FUTURE_DAYS = 120;

const tracked = {
  known: Schema.Record(
    Schema.String,
    Schema.Struct({ series: Schema.NullOr(Schema.String), end: Schema.NullOr(Schema.String) }),
  ),
  horizon: Schema.NullOr(Schema.String),
};

const Cursor = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      phase: Schema.Literal("full"),
      timeMin: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
      seen: Schema.NullOr(Schema.Array(Schema.String)),
      ...tracked,
    }),
    Schema.Struct({
      phase: Schema.Literal("incremental"),
      syncToken: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
      ...tracked,
    }),
  ]),
);
type Cursor = typeof Cursor.Type;
const encodeCursor = Schema.encodeSync(Cursor);
const decodeCursor = Schema.decodeUnknownSync(Cursor);

const isGone = (error: unknown) =>
  error instanceof GwsError && (error.code === 410 || error.code === 404);

const timeOf = (
  start: EventDateTime | undefined,
  end: EventDateTime | undefined,
): EventTime | null => {
  const from = start?.dateTime ?? start?.date;
  const to = end?.dateTime ?? end?.date;
  if (from === undefined || to === undefined) return null;
  return { start: from, end: to, allDay: start?.dateTime === undefined };
};

const seriesOf = (event: CalendarEvent) =>
  event.recurringEventId ?? (event.recurrence === undefined ? null : event.id);

const UNTIL = /^RRULE:(?:.*;)?UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/;

const seriesEndOf = (recurrence: ReadonlyArray<string>): string | null => {
  let last: string | null = null;
  for (const line of recurrence) {
    if (line.startsWith("EXDATE")) continue;
    const until = UNTIL.exec(line);
    if (until === null) return null;
    const [, year, month, day, hour = "23", minute = "59", second = "59"] = until;
    const end = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
    if (last === null || end > last) last = end;
  }
  return last;
};

const toEventItem = (
  event: CalendarEvent,
  calendarId: string,
  timeZone: string | null,
  now: number,
): RawItem => {
  const seriesId = seriesOf(event);
  const description = event.description ?? "";
  return {
    externalId: `${event.id}@${event.updated ?? event.status ?? "confirmed"}`,
    threadId: seriesId ?? event.id,
    containerId: calendarId,
    containerName: "Calendar",
    occurredAt: event.updated ?? new Date(now).toISOString(),
    title: event.summary ?? null,
    from: {
      name: event.organizer?.displayName ?? "",
      address: (event.organizer?.email ?? "").toLowerCase(),
    },
    fromVerified: false,
    format: "markdown",
    body: htmlBody(description).trim(),
    bodyNew: htmlBodyNew(description).trim(),
    link: event.htmlLink ?? null,
    raw: event,
    event: {
      eventId: event.id,
      seriesId,
      recurring: event.recurrence !== undefined,
      time: timeOf(event.start, event.end),
      timeZone: event.start?.timeZone ?? timeZone,
      location: event.location ?? null,
      attendees: (event.attendees ?? []).flatMap((attendee) =>
        attendee.email === undefined
          ? []
          : [
              {
                name: attendee.displayName ?? null,
                email: attendee.email.toLowerCase(),
                response: attendee.responseStatus ?? null,
              },
            ],
      ),
      status: event.status === "cancelled" ? "cancelled" : "confirmed",
      originalStart: event.originalStartTime?.dateTime ?? event.originalStartTime?.date ?? null,
    },
  };
};

const occurrencesOf = async (
  cli: Gws,
  calendarId: string,
  seriesId: string,
  window: { readonly timeMin: string; readonly timeMax: string },
  signal: AbortSignal,
): Promise<SeriesOccurrences> => {
  const instances = await listInstances(cli, calendarId, seriesId, window, signal).catch(
    (error: unknown) => {
      if (isGone(error)) return [];
      throw error;
    },
  );
  return {
    seriesId,
    occurrences: instances.flatMap((instance): Array<Occurrence> => {
      const time = timeOf(instance.start, instance.end);
      return time === null
        ? []
        : [
            {
              eventId: instance.id,
              ...time,
              status: instance.status === "cancelled" ? "cancelled" : "confirmed",
            },
          ];
    }),
  };
};

export const calendarSync = async (
  cli: Gws,
  calendarId: string,
  now: number,
  cursor: string | null,
  signal: AbortSignal,
): Promise<SyncPage> => {
  const window = {
    timeMin: new Date(now - PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + FUTURE_DAYS * DAY_MS).toISOString(),
  };
  const full: Cursor = {
    phase: "full",
    timeMin: window.timeMin,
    pageToken: null,
    seen: null,
    known: {},
    horizon: null,
  };
  const stored = cursor === null ? full : decodeCursor(cursor);
  const { position, listed } = await listEvents(cli, calendarId, stored, signal).then(
    (listed) => ({ position: stored, listed }),
    async (error: unknown) => {
      if (stored.phase !== "incremental" || !(error instanceof GwsError) || error.code !== 410)
        throw error;
      const relist: Cursor = { ...full, seen: [], known: stored.known, horizon: stored.horizon };
      return { position: relist, listed: await listEvents(cli, calendarId, relist, signal) };
    },
  );
  const items = listed.items ?? [];
  const known = new Map(Object.entries(position.known));
  const series = new Set<string>();
  for (const event of items) {
    const seriesId =
      seriesOf(event) ?? (known.get(event.id)?.series === event.id ? event.id : null);
    if (seriesId !== null) series.add(seriesId);
    if (event.status === "cancelled") known.delete(event.id);
    else
      known.set(event.id, {
        series: seriesOf(event),
        end:
          event.recurrence === undefined
            ? (event.end?.dateTime ?? event.end?.date ?? null)
            : seriesEndOf(event.recurrence),
      });
  }
  for (const [eventId, { end }] of known) {
    if (end !== null && Date.parse(end) <= Date.parse(window.timeMin)) known.delete(eventId);
  }
  const seen =
    position.phase === "full" && position.seen !== null
      ? [...position.seen, ...items.map(({ id }) => id)]
      : null;
  const listedIds = new Set(seen);
  const vanished =
    seen !== null && listed.nextPageToken === undefined && listed.nextSyncToken !== undefined
      ? [...known].filter(([eventId]) => !listedIds.has(eventId))
      : [];
  for (const [eventId, entry] of vanished) {
    known.delete(eventId);
    if (entry.series !== null) series.add(entry.series);
  }
  const due =
    position.horizon === null ||
    Date.parse(position.horizon) + DAY_MS <= Date.parse(window.timeMax);
  if (due) {
    for (const entry of known.values()) if (entry.series !== null) series.add(entry.series);
  }
  const occurrences = await Promise.all(
    [...series].map((seriesId) => occurrencesOf(cli, calendarId, seriesId, window, signal)),
  );
  const state = {
    known: Object.fromEntries(known),
    horizon: due ? window.timeMax : position.horizon,
  };
  const advanced: Cursor = position.phase === "full" ? { ...position, seen } : position;
  const next: Cursor =
    listed.nextPageToken !== undefined
      ? { ...advanced, ...state, pageToken: listed.nextPageToken }
      : listed.nextSyncToken !== undefined
        ? { phase: "incremental", syncToken: listed.nextSyncToken, pageToken: null, ...state }
        : { ...advanced, ...state, pageToken: null };
  const initial = position.phase === "full" && position.seen === null;
  const cancelledAt = new Date(now).toISOString();
  return {
    upserts: [
      ...items.map((event) => toEventItem(event, calendarId, listed.timeZone ?? null, now)),
      ...vanished.map(([eventId, entry]) =>
        toEventItem(
          {
            id: eventId,
            status: "cancelled",
            updated: cancelledAt,
            ...(entry.series === null || entry.series === eventId
              ? {}
              : { recurringEventId: entry.series }),
          },
          calendarId,
          null,
          now,
        ),
      ),
    ],
    deletions: [],
    cursor: encodeCursor(next),
    more: listed.nextPageToken !== undefined,
    occurrences,
    kind: initial ? "backfill" : "live",
    backfill: initial && next.phase === "full" ? "running" : "done",
  };
};
