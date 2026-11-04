import type { Row } from "@weir/daemon/Api";
import { describe, expect, it } from "vitest";
import {
  carriedLabel,
  dayBlocks,
  monthEntries,
  monthGrid,
  movedStart,
  plannedRows,
  resizedMinutes,
  scrollMinute,
  sequence,
  stepped,
  toDay,
  trayAge,
  trayRows,
} from "./PlanLayout.ts";
import type { Intents } from "./Rows.ts";
import type { Plan } from "./When.ts";

const row = (id: number, plan: Plan, planned_at: string | null = null): Row => ({
  id,
  source: "gmail",
  title: `#${id}`,
  tags: [],
  first_at: "2026-10-20T09:00:00.000Z",
  last_at: "2026-10-20T09:00:00.000Z",
  last_seq: id,
  seen_seq: id,
  cleared_seq: 0,
  muted: false,
  state: plan._tag === "None" ? "read" : "planned",
  new: 0,
  items: 1,
  participants: 1,
  from: { name: "Ada", address: "ada@example.com", me: false },
  preview: "",
  senders: [],
  plan,
  planned_at,
  due: null,
});

const at = (minute: number) => `2026-10-2${minute}T10:00:00.000Z`;
const monday = "2026-10-26";
const now = { date: monday, minute: 9 * 60 + 12 };
const none = new Map() as Intents;
const planned = (rows: ReadonlyArray<Row>, intents = none) => plannedRows(rows, intents);
const ids = (rows: ReadonlyArray<{ readonly id: number }>) => rows.map(({ id }) => id);
const placed = (rows: ReadonlyArray<Row>, date = monday, clock = now) =>
  dayBlocks(planned(rows), date, clock).map((block) => ({
    id: block.row.id,
    start: block.start,
    minutes: block.minutes,
    solid: block.solid,
    from: block.from,
    lane: block.lane,
    lanes: block.lanes,
  }));

describe("planned rows under pending intents", () => {
  it("a Plan intent moves the row before the server answers", () => {
    const intents: Intents = new Map([[1, { _tag: "Plan", plan: { _tag: "Tray" } }]]);
    const [moved] = planned([row(1, { _tag: "Day", date: monday })], intents);
    expect(moved?.plan).toEqual({ _tag: "Tray" });
  });

  it("Done, Mute and Back to inbox take the row out of Plan", () => {
    const intents: Intents = new Map([
      [1, { _tag: "Done", lastSeq: 1 }],
      [2, { _tag: "Mute" }],
      [3, { _tag: "Restore", clearedSeq: 0 }],
    ]);
    const rows = [1, 2, 3, 4].map((id) => row(id, { _tag: "Tray" }));
    expect(ids(planned(rows, intents))).toEqual([4]);
  });
});

describe("tray", () => {
  it("lists undated plans oldest first", () => {
    const rows = planned([
      row(1, { _tag: "Tray" }, at(4)),
      row(2, { _tag: "Day", date: monday }, at(1)),
      row(3, { _tag: "Tray" }, at(2)),
    ]);
    expect(ids(trayRows(rows))).toEqual([3, 1]);
  });

  it.each([
    ["2026-10-26T08:00:00.000Z", "In tray today"],
    ["2026-10-25T08:00:00.000Z", "In tray 1 day"],
    ["2026-10-19T08:00:00.000Z", "In tray 7 days"],
  ])("planned %s reads %s", (plannedAt, label) => {
    expect(trayAge(plannedAt, Date.parse("2026-10-26T09:00:00.000Z"))).toBe(label);
  });
});

describe("day timeline", () => {
  it("a slot is a solid block at its own time", () => {
    expect(placed([row(1, { _tag: "Slot", date: monday, start: 600, minutes: 45 })])).toEqual([
      { id: 1, start: 600, minutes: 45, solid: true, from: null, lane: 0, lanes: 1 },
    ]);
  });

  it("today's day plans start at now rounded up to 15 minutes, 30 minutes each, by planned_at", () => {
    const rows = [
      row(1, { _tag: "Day", date: monday }, at(3)),
      row(2, { _tag: "Day", date: monday }, at(1)),
    ];
    expect(placed(rows).map(({ id, start, minutes }) => [id, start, minutes])).toEqual([
      [2, 555, 30],
      [1, 585, 30],
    ]);
  });

  it("before 08:00 today and on other days, day plans start at 08:00", () => {
    const rows = [row(1, { _tag: "Day", date: monday })];
    expect(placed(rows, monday, { date: monday, minute: 6 * 60 })[0]?.start).toBe(480);
    const tuesday = "2026-10-27";
    expect(placed([row(1, { _tag: "Day", date: tuesday })], tuesday)[0]?.start).toBe(480);
  });

  it("day plans fill the free time around slots, never over them", () => {
    const tuesday = "2026-10-27";
    const rows = [
      row(1, { _tag: "Slot", date: tuesday, start: 495, minutes: 30 }),
      row(2, { _tag: "Day", date: tuesday }, at(1)),
      row(3, { _tag: "Day", date: tuesday }, at(2)),
      row(4, { _tag: "Slot", date: tuesday, start: 600, minutes: 60 }),
      row(5, { _tag: "Day", date: tuesday }, at(3)),
      row(6, { _tag: "Day", date: tuesday }, at(4)),
    ];
    expect(placed(rows, tuesday).map(({ id, start }) => [id, start])).toEqual([
      [1, 495],
      [2, 525],
      [3, 555],
      [4, 600],
      [5, 660],
      [6, 690],
    ]);
  });

  it("a past day or slot carries over to today as a dashed block labelled with its day", () => {
    const rows = [
      row(1, { _tag: "Slot", date: "2026-10-22", start: 600, minutes: 30 }, at(1)),
      row(2, { _tag: "Day", date: "2026-10-23" }, at(2)),
    ];
    expect(placed(rows).map(({ id, solid, from }) => [id, solid, from])).toEqual([
      [1, false, "2026-10-22"],
      [2, false, "2026-10-23"],
    ]);
    expect(placed(rows, "2026-10-22")).toEqual([]);
    expect(carriedLabel("2026-10-22", monday)).toBe("from Thu");
    expect(carriedLabel("2026-10-12", monday)).toBe("from Oct 12");
  });

  it("overlapping slots sit side by side", () => {
    const rows = [
      row(1, { _tag: "Slot", date: monday, start: 600, minutes: 60 }),
      row(2, { _tag: "Slot", date: monday, start: 630, minutes: 30 }),
      row(3, { _tag: "Slot", date: monday, start: 720, minutes: 30 }),
    ];
    expect(placed(rows).map(({ id, lane, lanes }) => [id, lane, lanes])).toEqual([
      [1, 0, 2],
      [2, 1, 2],
      [3, 0, 1],
    ]);
  });

  it("opens scrolled to an hour before now, never before 08:00", () => {
    expect(scrollMinute(monday, { date: monday, minute: 14 * 60 })).toBe(13 * 60);
    expect(scrollMinute(monday, { date: monday, minute: 8 * 60 + 30 })).toBe(480);
    expect(scrollMinute("2026-10-27", { date: monday, minute: 14 * 60 })).toBe(480);
  });
});

describe("dragging on the timeline", () => {
  it("moves snap to 15 minutes and stay inside the day", () => {
    expect(movedStart(607, 30)).toBe(600);
    expect(movedStart(608, 30)).toBe(615);
    expect(movedStart(-40, 30)).toBe(0);
    expect(movedStart(1435, 60)).toBe(1380);
  });

  it("resizes snap to 15 minutes with at least 15", () => {
    expect(resizedMinutes(600, 652)).toBe(45);
    expect(resizedMinutes(600, 590)).toBe(15);
    expect(resizedMinutes(1410, 1500)).toBe(30);
  });
});

describe("month", () => {
  it("shows six weeks from the Monday on or before the first", () => {
    const days = monthGrid("2026-10");
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-09-28");
    expect(days[3]).toBe("2026-10-01");
    expect(days[41]).toBe("2026-11-08");
  });

  it("a day lists timed plans by time, then day plans, carried-over plans on today", () => {
    const rows = planned([
      row(1, { _tag: "Day", date: monday }, at(1)),
      row(2, { _tag: "Slot", date: monday, start: 900, minutes: 30 }, at(2)),
      row(3, { _tag: "Slot", date: monday, start: 600, minutes: 30 }, at(3)),
      row(4, { _tag: "Day", date: "2026-10-20" }, at(4)),
    ]);
    expect(ids(monthEntries(rows, monday, monday))).toEqual([3, 2, 1, 4]);
    expect(ids(monthEntries(rows, "2026-10-20", monday))).toEqual([]);
  });

  it("dropping on a day keeps a slot's time and makes anything else a day plan", () => {
    const [slot, tray] = planned([
      row(1, { _tag: "Slot", date: monday, start: 600, minutes: 45 }),
      row(2, { _tag: "Tray" }),
    ]);
    if (slot === undefined || tray === undefined) throw new Error("expected two rows");
    expect(toDay(slot, "2026-10-29", monday)).toEqual({
      _tag: "Slot",
      date: "2026-10-29",
      start: 600,
      minutes: 45,
    });
    expect(toDay(tray, "2026-10-29", monday)).toEqual({ _tag: "Day", date: "2026-10-29" });
  });
});

describe("j and k order", () => {
  it("walks the Tray, then each day by time", () => {
    const rows = planned([
      row(1, { _tag: "Day", date: "2026-10-27" }, at(1)),
      row(2, { _tag: "Tray" }, at(2)),
      row(3, { _tag: "Slot", date: monday, start: 600, minutes: 30 }, at(3)),
      row(4, { _tag: "Day", date: monday }, at(4)),
    ]);
    expect(ids(sequence(rows, monday))).toEqual([2, 3, 4, 1]);
  });
});

describe("arrows", () => {
  it("step a day in Day and a month in Month", () => {
    expect(stepped("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(stepped("day", "2026-10-01", -1)).toBe("2026-09-30");
    expect(stepped("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(stepped("month", "2026-10-26", -1)).toBe("2026-09-01");
  });
});
