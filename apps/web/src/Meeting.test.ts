import type { EventDetail } from "@weir/daemon/Api";
import { describe, expect, it } from "vitest";
import { attendeeLine, changeDiff, eventWhen, isCancelled } from "./Meeting.ts";

const zone = "America/Los_Angeles";
const today = "2026-10-25";

const event = (overrides: Partial<EventDetail> = {}): EventDetail => ({
  event_id: "uat",
  series_id: null,
  start: "2026-10-30T14:00:00-07:00",
  end: "2026-10-30T15:00:00-07:00",
  all_day: false,
  location: "Larkspur room",
  attendees: [],
  status: "confirmed",
  change: null,
  recurring: false,
  ...overrides,
});

describe("a meeting change in the reader", () => {
  it("a moved meeting strikes its old time and shows the new one", () => {
    expect(
      changeDiff(
        event({
          change: {
            _tag: "Moved",
            from_start: "2026-10-29T10:00:00-07:00",
            from_end: "2026-10-29T11:00:00-07:00",
          },
        }),
        zone,
      ),
    ).toEqual({ from: "Thu 10:00", to: "Fri 14:00" });
  });

  it("a relocated meeting strikes its old place and shows the new one", () => {
    expect(
      changeDiff(event({ change: { _tag: "Relocated", from_location: "Fennel & Rye" } }), zone),
    ).toEqual({ from: "Fennel & Rye", to: "Larkspur room" });
    expect(
      changeDiff(
        event({ location: null, change: { _tag: "Relocated", from_location: null } }),
        zone,
      ),
    ).toEqual({ from: "no place", to: "no place" });
  });

  it("a new invite has no diff line", () => {
    expect(changeDiff(event({ change: { _tag: "Created" } }), zone)).toBeNull();
    expect(changeDiff(event(), zone)).toBeNull();
  });

  it("a cancellation reads as cancelled, by status or by change", () => {
    expect(isCancelled(event({ status: "cancelled" }))).toBe(true);
    expect(isCancelled(event({ change: { _tag: "Cancelled" } }))).toBe(true);
    expect(isCancelled(event())).toBe(false);
  });
});

describe("a meeting card's time and people", () => {
  it("a timed meeting shows its day and local time span", () => {
    expect(eventWhen(event(), zone, today)).toBe("Fri Oct 30 · 14:00–15:00");
  });

  it("an all-day meeting shows its day, or its range when it spans days", () => {
    expect(
      eventWhen(event({ all_day: true, start: "2026-10-31", end: "2026-11-01" }), zone, today),
    ).toBe("Sat Oct 31 · all day");
    expect(
      eventWhen(event({ all_day: true, start: "2026-10-31", end: "2026-11-03" }), zone, today),
    ).toBe("Oct 31 – Nov 2 · all day");
  });

  it("names up to three people, then counts the rest", () => {
    const person = (name: string | null, email: string) => ({ name, email, response: null });
    expect(attendeeLine([])).toBeNull();
    expect(
      attendeeLine([person("Priya Raman", "priya@x.example"), person(null, "ada@x.example")]),
    ).toBe("with Priya Raman, ada");
    expect(
      attendeeLine([
        person("A", "a@x"),
        person("B", "b@x"),
        person("C", "c@x"),
        person("D", "d@x"),
        person("E", "e@x"),
      ]),
    ).toBe("with A, B, C and 2 more");
  });
});
