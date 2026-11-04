import type { Row } from "@weir/daemon/Api";
import type { Scale } from "./Route.ts";
import type { Intents } from "./Rows.ts";
import {
  addDays,
  addMonths,
  daysBetween,
  monthDay,
  monthOf,
  type Planned,
  type Today,
  weekdayName,
  weekdayOf,
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

export type Block = {
  readonly row: DatedRow;
  readonly start: number;
  readonly minutes: number;
  readonly solid: boolean;
  readonly from: string | null;
  readonly lane: number;
  readonly lanes: number;
};

type Placed = Omit<Block, "lane" | "lanes">;

const ceilTo = (minute: number, step: number) => Math.ceil(minute / step) * step;

export const packStart = (date: string, now: Today) =>
  date === now.date ? Math.max(ceilTo(now.minute, snapMinutes), workdayStart) : workdayStart;

const freeAt = (busy: ReadonlyArray<Placed>, from: number, minutes: number) => {
  let start = from;
  for (const taken of busy.toSorted((left, right) => left.start - right.start)) {
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

export const dayBlocks = (rows: ReadonlyArray<PlannedRow>, date: string, now: Today) => {
  const on = datedOn(rows, date, now.date);
  const solid = on.flatMap((row): ReadonlyArray<Placed> => {
    const start = fixedStart(row, now.date);
    return start === null || row.plan._tag !== "Slot"
      ? []
      : [{ row, start, minutes: row.plan.minutes, solid: true, from: null }];
  });
  const placed: Array<Placed> = [...solid];
  for (const row of on
    .filter((candidate) => fixedStart(candidate, now.date) === null)
    .toSorted(byPlannedAt)) {
    placed.push({
      row,
      start: freeAt(placed, packStart(date, now), dayPlanMinutes),
      minutes: dayPlanMinutes,
      solid: false,
      from: carriedFrom(row, now.date),
    });
  }
  return withLanes(placed);
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

export const monthGrid = (month: string) => {
  const first = `${month}-01`;
  const start = addDays(first, -((weekdayOf(first) + 6) % 7));
  return Array.from({ length: 42 }, (_, at) => addDays(start, at));
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
