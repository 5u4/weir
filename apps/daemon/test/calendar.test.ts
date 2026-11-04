import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { FIXTURE_NOW, seedMailbox } from "@weir/fixtures";
import { gws } from "@weir/plugin-gws";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Http from "../src/Http.ts";
import { adjustableClock, apiClient, eventually, makeHome } from "./harness.ts";

process.env.TZ = "America/Los_Angeles";

const calendarSource = (mailbox: string) => `[[source]]
id = "gmail"
plugin = "gws"
sync_every = "1h"

[source.config]
command = ["${join(import.meta.dirname, "../node_modules/.bin/fake-gws")}", "--mailbox", "${mailbox}"]
backfill = "newer_than:30d"
labels = ["INBOX"]
calendar = "primary"
`;

describe("meetings", () => {
  it.live(
    "a series shows its moved occurrence, drops the cancelled one and keeps 09:30 over DST",
    () =>
      Effect.gen(function* () {
        const { clock } = yield* adjustableClock(FIXTURE_NOW);
        const { home, port, writeConfig } = makeHome("");
        const mailbox = join(home.root, "mailbox");
        seedMailbox(mailbox);
        writeConfig(calendarSource(mailbox));
        yield* Layer.build(Http.layer(home, { gws })).pipe(
          Effect.provideService(Clock.Clock, clock),
        );
        const client = yield* apiClient(port);
        yield* eventually(
          client.status(),
          ({ sources }) =>
            sources[0]?.streams.length === 2 &&
            sources[0].streams.every(({ backfill }) => backfill === "done"),
        );

        const { meetings } = yield* client.meetings({
          query: { from: "2026-10-26", to: "2026-11-06" },
        });
        const series = meetings.filter(({ title }) => title === "Weekday 1:1");
        expect(series.map(({ start, end }) => [start, end])).toEqual([
          ["2026-10-26T09:30:00-07:00", "2026-10-26T10:00:00-07:00"],
          ["2026-10-27T09:30:00-07:00", "2026-10-27T10:00:00-07:00"],
          ["2026-10-28T11:00:00-07:00", "2026-10-28T11:30:00-07:00"],
          ["2026-10-30T09:30:00-07:00", "2026-10-30T10:00:00-07:00"],
          ["2026-11-02T09:30:00-08:00", "2026-11-02T10:00:00-08:00"],
          ["2026-11-03T09:30:00-08:00", "2026-11-03T10:00:00-08:00"],
          ["2026-11-04T09:30:00-08:00", "2026-11-04T10:00:00-08:00"],
          ["2026-11-05T09:30:00-08:00", "2026-11-05T10:00:00-08:00"],
          ["2026-11-06T09:30:00-08:00", "2026-11-06T10:00:00-08:00"],
        ]);
        expect(series.every(({ recurring }) => recurring)).toBe(true);
        expect(new Set(series.map(({ conversation_id }) => conversation_id)).size).toBe(1);
        expect(series.find(({ start }) => start.startsWith("2026-10-28"))?.change).toEqual({
          _tag: "Moved",
          from_start: "2026-10-28T09:30:00-07:00",
          from_end: "2026-10-28T10:00:00-07:00",
        });

        expect(
          meetings
            .filter(({ recurring }) => !recurring)
            .map(({ title, start, end, all_day, status }) => [title, start, end, all_day, status]),
        ).toEqual([
          [
            "Northwind UAT review",
            "2026-10-29T10:00:00-07:00",
            "2026-10-29T11:00:00-07:00",
            false,
            "confirmed",
          ],
          ["Northwind cutover freeze", "2026-10-31", "2026-11-01", true, "confirmed"],
          [
            "Go-live check-in",
            "2026-11-02T08:00:00-08:00",
            "2026-11-02T08:30:00-08:00",
            false,
            "confirmed",
          ],
        ]);

        const saturday = yield* client.meetings({
          query: { from: "2026-10-31", to: "2026-10-31" },
        });
        expect(saturday.meetings.map(({ title }) => title)).toEqual(["Northwind cutover freeze"]);
      }).pipe(Effect.scoped),
  );

  it.live("a day's range covers all 25 hours of the DST fall-back day", () =>
    Effect.gen(function* () {
      const { clock } = yield* adjustableClock(FIXTURE_NOW);
      const { home, port, writeConfig } = makeHome("");
      const mailbox = join(home.root, "mailbox");
      seedMailbox(mailbox);
      const file = join(mailbox, "mailbox.json");
      const seeded = JSON.parse(readFileSync(file, "utf8"));
      seeded.calendar.version += 1;
      seeded.calendar.events.latenight = {
        kind: "calendar#event",
        id: "latenight",
        status: "confirmed",
        htmlLink: "https://www.google.com/calendar/event?eid=latenight",
        created: "2026-10-20T17:00:00.000Z",
        updated: "2026-10-20T17:00:00.000Z",
        summary: "Late night deploy",
        organizer: seeded.calendar.events.nwuat.organizer,
        attendees: [],
        start: { dateTime: "2026-11-01T23:30:00-08:00", timeZone: "America/Los_Angeles" },
        end: { dateTime: "2026-11-01T23:45:00-08:00", timeZone: "America/Los_Angeles" },
        version: seeded.calendar.version,
      };
      writeFileSync(file, JSON.stringify(seeded));
      writeConfig(calendarSource(mailbox));
      yield* Layer.build(Http.layer(home, { gws })).pipe(Effect.provideService(Clock.Clock, clock));
      const client = yield* apiClient(port);
      yield* eventually(
        client.status(),
        ({ sources }) =>
          sources[0]?.streams.length === 2 &&
          sources[0].streams.every(({ backfill }) => backfill === "done"),
      );

      const sunday = yield* client.meetings({
        query: { from: "2026-11-01", to: "2026-11-01" },
      });
      expect(sunday.meetings.map(({ title }) => title)).toEqual(["Late night deploy"]);
    }).pipe(Effect.scoped),
  );
});
