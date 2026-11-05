import { scenarios } from "./scenarios.ts";

export const CALENDAR_ZONE = "America/Los_Angeles";

export type EventTime = { date?: string; dateTime?: string; timeZone?: string };
export type EventPerson = {
  email: string;
  displayName: string;
  responseStatus?: string;
  self?: boolean;
};
export type CalendarEvent = {
  kind: "calendar#event";
  id: string;
  status: "confirmed" | "cancelled";
  htmlLink: string;
  created: string;
  updated: string;
  summary: string;
  description?: string;
  location?: string;
  organizer: EventPerson;
  attendees: EventPerson[];
  start: EventTime;
  end: EventTime;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: EventTime;
};
export type StoredEvent = CalendarEvent & { version: number };
export type Calendar = {
  summary: string;
  timeZone: string;
  version: number;
  applied: number;
  events: Record<string, StoredEvent>;
};

type Revision = {
  at: string;
  id: string;
  event: Partial<Omit<CalendarEvent, "kind" | "id" | "created" | "updated" | "htmlLink">>;
};

const person = (key: string, responseStatus?: string): EventPerson => {
  const found = scenarios.people[key];
  if (!found) throw new Error(`calendar fixture names unknown person ${key}`);
  return {
    email: found.addr,
    displayName: found.name,
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(key === scenarios.me ? { self: true } : {}),
  };
};

const at = (dateTime: string): EventTime => ({ dateTime, timeZone: CALENDAR_ZONE });

const WEEKDAY_1ON1 = "weekday1on1";

export const REVISIONS: ReadonlyArray<Revision> = [
  {
    at: "2026-09-01T10:00:00-07:00",
    id: WEEKDAY_1ON1,
    event: {
      status: "confirmed",
      summary: "Weekday 1:1",
      description:
        "Standing check-in with Lisa: blockers, priorities for the day, anything that needs a decision.",
      location: "Lisa's office",
      organizer: person("lisa"),
      attendees: [person("lisa", "accepted"), person("me", "accepted")],
      start: at("2026-09-07T09:30:00-07:00"),
      end: at("2026-09-07T10:00:00-07:00"),
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
    },
  },
  {
    at: "2026-10-15T16:30:00-07:00",
    id: "nwfreeze",
    event: {
      status: "confirmed",
      summary: "Northwind cutover freeze",
      description:
        "Write freeze on the old billing system from Saturday Oct 31 at 18:00 PT while Northwind migrates the data over the weekend.",
      organizer: person("rachel"),
      attendees: [
        person("rachel", "accepted"),
        person("me", "accepted"),
        person("ben", "accepted"),
      ],
      start: { date: "2026-10-31" },
      end: { date: "2026-11-01" },
    },
  },
  {
    at: "2026-10-16T11:00:00-07:00",
    id: "nwgolive",
    event: {
      status: "confirmed",
      summary: "Go-live check-in",
      description:
        "Confirm billing runs on Northwind on Monday Nov 2 before customers start invoicing.",
      location: "Room 4B",
      organizer: person("rachel"),
      attendees: [
        person("rachel", "accepted"),
        person("me", "accepted"),
        person("lisa", "tentative"),
      ],
      start: at("2026-11-02T08:00:00-08:00"),
      end: at("2026-11-02T08:30:00-08:00"),
    },
  },
  {
    at: "2026-10-17T13:10:00-07:00",
    id: "nwuat",
    event: {
      status: "confirmed",
      summary: "Northwind UAT review",
      description: "Walk through the UAT results with Omar and Ben before sign-off.",
      location: "Zoom",
      organizer: person("rachel"),
      attendees: [
        person("rachel", "accepted"),
        person("omar", "accepted"),
        person("ben", "needsAction"),
        person("me", "accepted"),
      ],
      start: at("2026-10-29T10:00:00-07:00"),
      end: at("2026-10-29T11:00:00-07:00"),
    },
  },
  {
    at: "2026-10-19T10:00:00-07:00",
    id: `${WEEKDAY_1ON1}_20261028T163000Z`,
    event: {
      status: "confirmed",
      summary: "Weekday 1:1",
      location: "Lisa's office",
      organizer: person("lisa"),
      attendees: [person("lisa", "accepted"), person("me", "accepted")],
      recurringEventId: WEEKDAY_1ON1,
      originalStartTime: at("2026-10-28T09:30:00-07:00"),
      start: at("2026-10-28T11:00:00-07:00"),
      end: at("2026-10-28T11:30:00-07:00"),
    },
  },
  {
    at: "2026-10-19T10:05:00-07:00",
    id: `${WEEKDAY_1ON1}_20261029T163000Z`,
    event: {
      status: "cancelled",
      summary: "Weekday 1:1",
      organizer: person("lisa"),
      attendees: [person("lisa", "accepted"), person("me", "accepted")],
      recurringEventId: WEEKDAY_1ON1,
      originalStartTime: at("2026-10-29T09:30:00-07:00"),
      start: at("2026-10-29T09:30:00-07:00"),
      end: at("2026-10-29T10:00:00-07:00"),
    },
  },
  {
    at: "2026-10-24T10:15:00-07:00",
    id: "mom60lunch",
    event: {
      status: "confirmed",
      summary: "Mom's 60th lunch",
      description: "Family lunch for Mom's birthday. The book club is the surprise.",
      location: "Fennel & Rye",
      organizer: person("dan"),
      attendees: [person("dan", "accepted"), person("me", "needsAction")],
      start: at("2026-12-07T12:30:00-08:00"),
      end: at("2026-12-07T14:30:00-08:00"),
    },
  },
  {
    at: "2026-10-25T09:10:00-07:00",
    id: "nwuat",
    event: {
      start: at("2026-10-30T14:00:00-07:00"),
      end: at("2026-10-30T15:00:00-07:00"),
    },
  },
  {
    at: "2026-10-25T09:20:00-07:00",
    id: "nwgolive",
    event: { status: "cancelled" },
  },
  {
    at: "2026-10-25T09:30:00-07:00",
    id: "mom60lunch",
    event: { location: "Larkspur room" },
  },
  {
    at: "2026-10-25T09:40:00-07:00",
    id: "designcrit",
    event: {
      status: "confirmed",
      summary: "Design crit",
      description:
        "Bring the payout dashboard mocks; we will pick one direction for the retry states.",
      location: "Studio",
      organizer: person("priya"),
      attendees: [person("priya", "accepted"), person("me", "needsAction")],
      start: at("2026-11-04T15:00:00-08:00"),
      end: at("2026-11-04T16:00:00-08:00"),
    },
  },
];

export const CALENDAR_CHANGES_AT = "2026-10-25T10:00:00-07:00";

export const emptyCalendar = (summary: string): Calendar => ({
  summary,
  timeZone: CALENDAR_ZONE,
  version: 0,
  applied: 0,
  events: {},
});

export const applyRevisions = (calendar: Calendar, until: string): string[] => {
  const cutoff = Date.parse(until);
  const ids: string[] = [];
  for (const revision of REVISIONS.slice(calendar.applied)) {
    if (Date.parse(revision.at) > cutoff) break;
    const previous = calendar.events[revision.id];
    const updated = new Date(Date.parse(revision.at)).toISOString();
    calendar.version += 1;
    calendar.applied += 1;
    const merged = { ...previous, ...revision.event };
    if (merged.summary === undefined || merged.start === undefined || merged.end === undefined) {
      throw new Error(`calendar revision ${revision.id} at ${revision.at} has no prior event`);
    }
    calendar.events[revision.id] = {
      ...merged,
      kind: "calendar#event",
      id: revision.id,
      status: merged.status ?? "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${revision.id}`,
      created: previous?.created ?? updated,
      updated,
      summary: merged.summary,
      organizer: merged.organizer ?? person("me"),
      attendees: merged.attendees ?? [],
      start: merged.start,
      end: merged.end,
      version: calendar.version,
    };
    ids.push(revision.id);
  }
  return ids;
};

const offsetMinutes = (utcMs: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return (
    (Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    ) -
      utcMs) /
    60_000
  );
};

export const zonedTime = (date: string, clock: string, timeZone: string) => {
  const naive = Date.parse(`${date}T${clock}Z`);
  const guess = naive - offsetMinutes(naive, timeZone) * 60_000;
  const offset = offsetMinutes(guess, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return {
    utcMs: naive - offset * 60_000,
    dateTime: `${date}T${clock}${sign}${hours}:${minutes}`,
  };
};

export const localParts = (dateTime: string, timeZone: string) => {
  const utcMs = Date.parse(dateTime);
  const local = new Date(utcMs + offsetMinutes(utcMs, timeZone) * 60_000).toISOString();
  return { date: local.slice(0, 10), clock: local.slice(11, 19) };
};
