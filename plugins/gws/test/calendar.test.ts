import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncPage } from "@weir/contract/Source";
import { FIXTURE_NOW, fixtureFaceNet, readCalls, seedMailbox, setQuota } from "@weir/fixtures";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { createSource } from "../src/index.ts";

const FAKE_GWS = join(import.meta.dirname, "../node_modules/.bin/fake-gws");
const STREAM = "calendar/primary";
const DAY_MS = 86_400_000;
const decodePage = Schema.decodeUnknownSync(SyncPage, { onExcessProperty: "error" });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type FakeCalendar = { summary: string; version: number; events: Record<string, unknown> };
const editCalendar = (
  dir: string,
  edit: (mailbox: {
    pageSize: number;
    calendar: FakeCalendar;
    calendars?: Record<string, FakeCalendar>;
  }) => void,
) => {
  const file = join(dir, "mailbox.json");
  const mailbox = JSON.parse(readFileSync(file, "utf8"));
  edit(mailbox);
  writeFileSync(file, JSON.stringify(mailbox));
};

const calendarSource = (calendars: string[] = ["primary"]) => {
  const dir = mkdtempSync(join(tmpdir(), "weir-calendar-"));
  dirs.push(dir);
  seedMailbox(dir);
  const clock = { now: Date.parse(FIXTURE_NOW) };
  const source = createSource(
    {
      command: [FAKE_GWS, "--mailbox", dir],
      backfill: "newer_than:30d",
      labels: ["INBOX"],
      calendars,
    },
    async () => {},
    { now: () => clock.now },
    fixtureFaceNet(),
  );
  const sync = async (cursor: string | null, stream = STREAM) =>
    decodePage(await source.sync(stream, cursor, new AbortController().signal));
  const syncAll = async (cursor: string | null, stream = STREAM) => {
    const pages: SyncPage[] = [];
    let position = cursor;
    let more = true;
    while (more) {
      const page = await sync(position, stream);
      pages.push(page);
      position = page.cursor;
      more = page.more;
    }
    return { pages, cursor: position ?? "" };
  };
  return { dir, clock, source, sync, syncAll };
};

const cancelled = (pages: ReadonlyArray<SyncPage>) =>
  pages.flatMap(({ upserts }) =>
    upserts.flatMap((item) =>
      item.event?.status === "cancelled" ? [[item.event.eventId, item.threadId]] : [],
    ),
  );

const MOVED_ONE_ON_ONE = "weekday1on1_20261028T163000Z";

describe("calendar relist after an expired sync token", () => {
  it("cancels events that vanished once the relist completes", async () => {
    const { dir, sync, syncAll } = calendarSource();
    editCalendar(dir, (mailbox) => {
      mailbox.pageSize = 2;
    });
    const backfill = await syncAll(null);
    expect(cancelled(backfill.pages)).toEqual([]);
    editCalendar(dir, ({ calendar }) => {
      delete calendar.events.nwfreeze;
      delete calendar.events[MOVED_ONE_ON_ONE];
      calendar.version -= 1;
    });

    const first = await sync(backfill.cursor);
    expect(first.more).toBe(true);
    expect(first.kind).toBe("live");
    expect(first.backfill).toBe("done");
    const rest = await syncAll(first.cursor);
    const pages = [first, ...rest.pages];

    expect(pages.slice(0, -1).flatMap((page) => cancelled([page]))).toEqual([]);
    expect(cancelled(pages).sort()).toEqual([
      ["nwfreeze", "nwfreeze"],
      [MOVED_ONE_ON_ONE, "weekday1on1"],
    ]);
    expect(cancelled((await syncAll(rest.cursor)).pages)).toEqual([]);
  });

  it("marks nothing when the relist fails midway and reconciles on the retry", async () => {
    const { dir, sync, syncAll } = calendarSource();
    editCalendar(dir, (mailbox) => {
      mailbox.pageSize = 2;
    });
    const backfill = await syncAll(null);
    editCalendar(dir, ({ calendar }) => {
      delete calendar.events.nwfreeze;
      calendar.version -= 1;
    });

    const first = await sync(backfill.cursor);
    expect(cancelled([first])).toEqual([]);
    setQuota(dir, { until: Date.parse("2999-01-01T00:00:00Z"), methods: ["calendar events list"] });
    await expect(sync(first.cursor)).rejects.toThrow("Quota exceeded");
    setQuota(dir, undefined);

    const retried = await syncAll(first.cursor);
    expect(cancelled(retried.pages)).toEqual([["nwfreeze", "nwfreeze"]]);
    expect(cancelled(retried.pages.slice(0, -1))).toEqual([]);
  });
});

describe("calendar occurrence window", () => {
  it("advances a quiet series' window with occurrences only", async () => {
    const { dir, clock, syncAll } = calendarSource();
    editCalendar(dir, (mailbox) => {
      mailbox.pageSize = 50;
    });
    const backfill = await syncAll(null);
    const instancesCalls = () =>
      readCalls(dir).filter(({ command }) => command === "calendar events instances");
    const before = instancesCalls().length;

    const sameDay = await syncAll(backfill.cursor);
    expect(sameDay.pages.flatMap(({ occurrences = [] }) => occurrences)).toEqual([]);
    expect(instancesCalls().length).toBe(before);

    clock.now += 2 * DAY_MS;
    const later = await syncAll(sameDay.cursor);
    expect(later.pages.flatMap(({ upserts }) => upserts)).toEqual([]);
    const refreshed = later.pages.flatMap(({ occurrences = [] }) => occurrences);
    expect(refreshed.map(({ seriesId }) => seriesId)).toEqual(["weekday1on1"]);
    const horizon = new Date(clock.now + 120 * DAY_MS).toISOString();
    expect(
      instancesCalls()
        .slice(before)
        .map(({ params }) => params.timeMax),
    ).toEqual([horizon]);
    const starts = refreshed[0]?.occurrences.map(({ start }) => Date.parse(start)) ?? [];
    expect(Math.max(...starts)).toBeGreaterThan(Date.parse(FIXTURE_NOW) + 120 * DAY_MS);
  });
});

describe("several calendars on one source", () => {
  it("streams each calendar under its display name and syncs only its own events", async () => {
    const team = "team@group.calendar.google.com";
    const { dir, source, syncAll } = calendarSource(["primary", team]);
    editCalendar(dir, (mailbox) => {
      const { nwfreeze, ...rest } = mailbox.calendar.events;
      mailbox.calendar.summary = "Robin";
      mailbox.calendar.events = rest;
      mailbox.calendars = {
        [team]: { ...mailbox.calendar, summary: "Northwind team", events: { nwfreeze } },
      };
    });

    const events = (await source.streams()).filter(({ kind }) => kind === "event");
    expect(events.map(({ id, name }) => [id, name])).toEqual([
      ["calendar/primary", "Robin"],
      [`calendar/${team}`, "Northwind team"],
    ]);

    const eventIds = (pages: ReadonlyArray<SyncPage>) => [
      ...new Set(
        pages.flatMap(({ upserts }) =>
          upserts.flatMap((item) => (item.event ? [item.event.eventId] : [])),
        ),
      ),
    ];
    const primary = eventIds((await syncAll(null)).pages);
    expect(primary.length).toBeGreaterThan(0);
    expect(primary).not.toContain("nwfreeze");
    expect(eventIds((await syncAll(null, `calendar/${team}`)).pages)).toEqual(["nwfreeze"]);
  });
});
