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

const Cursor = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      phase: Schema.Literal("full"),
      timeMin: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({
      phase: Schema.Literal("incremental"),
      syncToken: Schema.String,
      pageToken: Schema.NullOr(Schema.String),
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
  now: number,
  signal: AbortSignal,
): Promise<SeriesOccurrences> => {
  const window = {
    timeMin: new Date(now - PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + FUTURE_DAYS * DAY_MS).toISOString(),
  };
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
  const full: Cursor = {
    phase: "full",
    timeMin: new Date(now - PAST_DAYS * DAY_MS).toISOString(),
    pageToken: null,
  };
  const stored = cursor === null ? full : decodeCursor(cursor);
  const { position, listed } = await listEvents(cli, calendarId, stored, signal).then(
    (listed) => ({ position: stored, listed }),
    async (error: unknown) => {
      if (stored.phase !== "incremental" || !(error instanceof GwsError) || error.code !== 410)
        throw error;
      return { position: full, listed: await listEvents(cli, calendarId, full, signal) };
    },
  );
  const items = listed.items ?? [];
  const series = [
    ...new Set(
      items.flatMap((event) => {
        const seriesId = seriesOf(event);
        return seriesId === null ? [] : [seriesId];
      }),
    ),
  ];
  const occurrences = await Promise.all(
    series.map((seriesId) => occurrencesOf(cli, calendarId, seriesId, now, signal)),
  );
  const next: Cursor =
    listed.nextPageToken !== undefined
      ? { ...position, pageToken: listed.nextPageToken }
      : listed.nextSyncToken !== undefined
        ? { phase: "incremental", syncToken: listed.nextSyncToken, pageToken: null }
        : { ...position, pageToken: null };
  return {
    upserts: items.map((event) => toEventItem(event, calendarId, listed.timeZone ?? null, now)),
    deletions: [],
    cursor: encodeCursor(next),
    more: listed.nextPageToken !== undefined,
    occurrences,
    kind: position.phase === "full" ? "backfill" : "live",
    backfill: next.phase === "incremental" ? "done" : "running",
  };
};
