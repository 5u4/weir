import type { Meeting, Row } from "@weir/daemon/Api";
import type { Scale } from "./Route.ts";
import type { Intents } from "./Rows.ts";
import {
  addDays,
  addMonths,
  clock,
  daysBetween,
  monthDay,
  monthOf,
  type Planned,
  slotMinutes,
  type Today,
  weekdayName,
  weekdayOf,
  zonedAt,
} from "./When.ts";

export type PlannedRow = Row & { readonly plan: Planned };

export type DatedRow = Row & { readonly plan: Extract<Planned, { readonly date: string }> };

export const snapMinutes = 15;
export const dayPlanMinutes = 30;
export const workdayStart = 8 * 60;
export const dayMinutes = 24 * 60;

export const plannedRows = (rows: ReadonlyArray<Row>, intents: Intents) =>
  rows.flatMap((row): ReadonlyArray<PlannedRow> => {
    const intent = intents.get(row.id);
    const plan = intent === undefined ? row.plan : intent._tag === "Plan" ? intent.plan : null;
    return plan === null || plan._tag === "None" ? [] : [{ ...row, plan }];
  });

const byPlannedAt = (left: Row, right: Row) =>
  (left.planned_at ?? "").localeCompare(right.planned_at ?? "") || left.id - right.id;

export const trayRows = (rows: ReadonlyArray<PlannedRow>) =>
  rows.filter((row) => row.plan._tag === "Tray").toSorted(byPlannedAt);

const isDated = (row: PlannedRow): row is DatedRow => row.plan._tag !== "Tray";

export const landing = (row: DatedRow, today: string) =>
  row.plan.date < today ? today : row.plan.date;

export const carriedFrom = (row: DatedRow, today: string) =>
  row.plan.date < today ? row.plan.date : null;

export const carriedLabel = (from: string, today: string) =>
  `from ${daysBetween(from, today) < 7 ? weekdayName(from) : monthDay(from, today)}`;

export const datedOn = (rows: ReadonlyArray<PlannedRow>, date: string, today: string) =>
  rows.filter(isDated).filter((row) => landing(row, today) === date);

const fixedStart = (row: DatedRow, today: string) =>
  row.plan._tag === "Slot" && carriedFrom(row, today) === null ? row.plan.start : null;

export const trayAge = (plannedAt: string | null, nowMs: number) => {
  const days =
    plannedAt === null ? 0 : Math.max(0, Math.floor((nowMs - Date.parse(plannedAt)) / 86_400_000));
  return days === 0 ? "In tray today" : days === 1 ? "In tray 1 day" : `In tray ${days} days`;
};

type Span = { readonly start: number; readonly minutes: number };

type Placed =
  | (Span & {
      readonly _tag: "Plan";
      readonly row: DatedRow;
      readonly solid: boolean;
      readonly from: string | null;
    })
  | (Span & { readonly _tag: "Meeting"; readonly meeting: Meeting });

type Lanes = { readonly lane: number; readonly lanes: number };

export type Block = Placed & Lanes;

export type MeetingSpan = Span & { readonly meeting: Meeting };

const ceilTo = (minute: number, step: number) => Math.ceil(minute / step) * step;

export const packStart = (date: string, now: Today) =>
  date === now.date ? Math.max(ceilTo(now.minute, snapMinutes), workdayStart) : workdayStart;

const byStart = (left: Span, right: Span) => left.start - right.start;

const freeAt = (busy: ReadonlyArray<Span>, from: number, minutes: number) => {
  let start = from;
  for (const taken of busy.toSorted(byStart)) {
    if (start + minutes <= taken.start) break;
    if (start < taken.start + taken.minutes) start = taken.start + taken.minutes;
  }
  return Math.min(start, dayMinutes - minutes);
};

const withLanes = (placed: ReadonlyArray<Placed>): ReadonlyArray<Block> => {
  const sorted = placed.toSorted(
    (left, right) => left.start - right.start || right.minutes - left.minutes,
  );
  const blocks: Array<Block> = [];
  let cluster: Array<Placed & { readonly lane: number }> = [];
  let ends: Array<number> = [];
  let clusterEnd = -1;
  const close = () => {
    for (const block of cluster) blocks.push({ ...block, lanes: ends.length });
    cluster = [];
    ends = [];
  };
  for (const block of sorted) {
    if (block.start >= clusterEnd) close();
    const free = ends.findIndex((end) => end <= block.start);
    const lane = free < 0 ? ends.length : free;
    ends[lane] = block.start + block.minutes;
    cluster.push({ ...block, lane });
    clusterEnd = Math.max(clusterEnd, block.start + block.minutes);
  }
  close();
  return blocks;
};

export const meetingSpans = (
  meetings: ReadonlyArray<Meeting>,
  date: string,
  zone: string,
): ReadonlyArray<MeetingSpan> =>
  meetings.flatMap((meeting) => {
    if (meeting.all_day) return [];
    const from = zonedAt(Date.parse(meeting.start), zone);
    const to = zonedAt(Date.parse(meeting.end), zone);
    if (from.date > date || to.date < date) return [];
    const start = from.date < date ? 0 : from.minute;
    const end = to.date > date ? dayMinutes : to.minute;
    return end > start ? [{ meeting, start, minutes: end - start }] : [];
  });

export const allDayOn = (meetings: ReadonlyArray<Meeting>, date: string) =>
  meetings.filter((meeting) => meeting.all_day && meeting.start <= date && date < meeting.end);

export const monthMeetings = (meetings: ReadonlyArray<Meeting>, date: string, zone: string) =>
  meetings
    .flatMap(
      (meeting): ReadonlyArray<{ readonly meeting: Meeting; readonly start: number | null }> => {
        if (meeting.recurring) return [];
        if (meeting.all_day) {
          return meeting.start <= date && date < meeting.end ? [{ meeting, start: null }] : [];
        }
        const at = zonedAt(Date.parse(meeting.start), zone);
        return at.date === date ? [{ meeting, start: at.minute }] : [];
      },
    )
    .toSorted((left, right) => (left.start ?? -1) - (right.start ?? -1));

const slotsOn = (rows: ReadonlyArray<PlannedRow>, date: string, today: string) =>
  datedOn(rows, date, today).flatMap((row) => {
    const start = fixedStart(row, today);
    return start === null || row.plan._tag !== "Slot"
      ? []
      : [{ row, start, minutes: row.plan.minutes }];
  });

export const placeDayPlans = (
  rows: ReadonlyArray<PlannedRow>,
  spans: ReadonlyArray<MeetingSpan>,
  date: string,
  now: Today,
) => {
  const meetings = spans.map((span): Placed => ({ _tag: "Meeting", ...span }));
  const solid = slotsOn(rows, date, now.date).map(
    (slot): Placed => ({ _tag: "Plan", ...slot, solid: true, from: null }),
  );
  const busy: Array<Span> = [
    ...spans.filter(({ meeting }) => meeting.status === "confirmed"),
    ...solid,
  ];
  const dashed: Array<Placed> = [];
  for (const row of datedOn(rows, date, now.date)
    .filter((candidate) => fixedStart(candidate, now.date) === null)
    .toSorted(byPlannedAt)) {
    const placed: Placed = {
      _tag: "Plan",
      row,
      start: freeAt(busy, packStart(date, now), dayPlanMinutes),
      minutes: dayPlanMinutes,
      solid: false,
      from: carriedFrom(row, now.date),
    };
    busy.push(placed);
    dashed.push(placed);
  }
  return withLanes([...meetings, ...solid, ...dashed]);
};

export type Gap = { readonly start: number; readonly end: number };

export const busyOn = (
  rows: ReadonlyArray<PlannedRow>,
  spans: ReadonlyArray<MeetingSpan>,
  date: string,
  today: string,
  except: number,
): ReadonlyArray<Span> => [
  ...spans.filter(({ meeting }) => meeting.status === "confirmed"),
  ...slotsOn(rows, date, today).filter(({ row }) => row.id !== except),
];

export const freeGaps = (busy: ReadonlyArray<Span>, from: number): ReadonlyArray<Gap> => {
  const gaps: Array<Gap> = [];
  let at = from;
  for (const taken of busy.toSorted(byStart)) {
    if (taken.start - at >= snapMinutes) gaps.push({ start: at, end: taken.start });
    at = Math.max(at, taken.start + taken.minutes);
  }
  if (dayMinutes - at >= snapMinutes) gaps.push({ start: at, end: dayMinutes });
  return gaps;
};

export const laterToday = (
  busy: ReadonlyArray<Span>,
  now: Today,
): { readonly plan: Planned; readonly preview: string } => {
  const gap = freeGaps(busy, packStart(now.date, now)).find(
    ({ start, end }) => end - start >= slotMinutes,
  );
  return gap === undefined
    ? { plan: { _tag: "Day", date: now.date }, preview: "Today · no free gap left" }
    : {
        plan: { _tag: "Slot", date: now.date, start: gap.start, minutes: slotMinutes },
        preview: `Today · ${clock(gap.start)} · ${gap.end >= dayMinutes ? "free the rest of the day" : `free until ${clock(gap.end)}`}`,
      };
};

export const scrollMinute = (date: string, now: Today) =>
  date === now.date ? Math.max(now.minute - 60, workdayStart) : workdayStart;

const snap = (minute: number) => Math.round(minute / snapMinutes) * snapMinutes;

export const movedStart = (minute: number, minutes: number) =>
  Math.min(Math.max(snap(minute), 0), dayMinutes - minutes);

export const resizedMinutes = (start: number, end: number) =>
  Math.max(snapMinutes, Math.min(snap(end), dayMinutes) - start);

export const toDay = (row: PlannedRow, date: string, today: string): Planned =>
  row.plan._tag === "Slot" && row.plan.date >= today
    ? { ...row.plan, date }
    : { _tag: "Day", date };

const gridStart = (month: string) => {
  const first = `${month}-01`;
  return addDays(first, -((weekdayOf(first) + 6) % 7));
};

export const monthGrid = (month: string) => {
  const start = gridStart(month);
  return Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)),
  );
};

export const gridRange = (month: string) => {
  const start = gridStart(month);
  return `${start}/${addDays(start, 41)}` as const;
};

export const stepped = (scale: Scale, date: string, by: 1 | -1) =>
  scale === "day" ? addDays(date, by) : `${addMonths(monthOf(date), by)}-01`;

export const monthEntries = (rows: ReadonlyArray<PlannedRow>, date: string, today: string) =>
  datedOn(rows, date, today).toSorted(
    (left, right) =>
      (fixedStart(left, today) ?? dayMinutes) - (fixedStart(right, today) ?? dayMinutes) ||
      byPlannedAt(left, right),
  );

export const inMonth = (rows: ReadonlyArray<PlannedRow>, month: string, today: string) =>
  rows.filter(isDated).filter((row) => monthOf(landing(row, today)) === month);

export const sequence = (rows: ReadonlyArray<PlannedRow>, today: string) => [
  ...trayRows(rows),
  ...rows
    .filter(isDated)
    .toSorted(
      (left, right) =>
        landing(left, today).localeCompare(landing(right, today)) ||
        (fixedStart(left, today) ?? dayMinutes) - (fixedStart(right, today) ?? dayMinutes) ||
        byPlannedAt(left, right),
    ),
];
