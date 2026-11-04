import { describe, expect, it } from "vitest";
import {
  type Dated,
  dueFlag,
  parseDue,
  parseWhen,
  planLabel,
  type Today,
  todayOf,
} from "./When.ts";

const sunday: Today = { date: "2026-10-25", minute: 9 * 60 };

const day = (date: string): Dated => ({ _tag: "Day", date });
const slot = (date: string, start: number): Dated => ({ _tag: "Slot", date, start, minutes: 30 });

describe("typed plan times from Sun Oct 25, 09:00", () => {
  it.each<[string, Dated, string]>([
    ["thu 3pm", slot("2026-10-29", 15 * 60), "Thu Oct 29, 15:00"],
    ["Thu, 3 PM", slot("2026-10-29", 15 * 60), "Thu Oct 29, 15:00"],
    ["nov 12", day("2026-11-12"), "Thu Nov 12 · any time"],
    ["12th nov", day("2026-11-12"), "Thu Nov 12 · any time"],
    ["next mon 9:30", slot("2026-10-26", 9 * 60 + 30), "Mon Oct 26, 09:30"],
    ["in 2 weeks", day("2026-11-08"), "Sun Nov 8 · any time"],
    ["in a month", day("2026-11-25"), "Wed Nov 25 · any time"],
    ["tomorrow", day("2026-10-26"), "Mon Oct 26 · any time"],
    ["today", day("2026-10-25"), "Sun Oct 25 · any time"],
    ["tonight", slot("2026-10-25", 19 * 60), "Sun Oct 25, 19:00"],
    ["3pm", slot("2026-10-25", 15 * 60), "Sun Oct 25, 15:00"],
    ["8am", slot("2026-10-26", 8 * 60), "Mon Oct 26, 08:00"],
    ["noon", slot("2026-10-25", 12 * 60), "Sun Oct 25, 12:00"],
    ["fri morning", slot("2026-10-30", 9 * 60), "Fri Oct 30, 09:00"],
    ["thu at 4", slot("2026-10-29", 16 * 60), "Thu Oct 29, 16:00"],
    ["nov 12 9", slot("2026-11-12", 9 * 60), "Thu Nov 12, 09:00"],
    ["next week", day("2026-10-26"), "Mon Oct 26 · any time"],
    ["11/3", day("2026-11-03"), "Tue Nov 3 · any time"],
    ["oct 20", day("2027-10-20"), "Wed Oct 20 2027 · any time"],
    ["2026-12-01", day("2026-12-01"), "Tue Dec 1 · any time"],
  ])("%s", (text, plan, preview) => {
    expect(parseWhen(text, sunday)).toEqual({ _tag: "Ok", value: plan, preview });
  });

  it("reads nothing from an empty field", () => {
    expect(parseWhen("   ", sunday)).toBeNull();
  });

  it.each([
    ["2026-02-30", "That date doesn't exist."],
    ["fri 25:00", "That time doesn't exist."],
    ["13pm", "That time doesn't exist."],
    ["10/20/2026", "That's already behind you. It's 09:00 on Sun Oct 25."],
    ["today 8am", "That's already behind you. It's 09:00 on Sun Oct 25."],
    ["soonish", "Can't read “soonish” yet. Try thu 3pm, nov 12, next mon 9:30 or in 2 weeks."],
  ])("rejects %s", (text, why) => {
    expect(parseWhen(text, sunday)).toEqual({ _tag: "Bad", why });
  });
});

describe("typed due dates", () => {
  it("takes a date", () => {
    expect(parseDue("nov 12", sunday)).toEqual({
      _tag: "Ok",
      value: "2026-11-12",
      preview: "Thu Nov 12",
    });
  });

  it("refuses a time", () => {
    expect(parseDue("thu 3pm", sunday)).toEqual({
      _tag: "Bad",
      why: "A due date has no time. Try fri, nov 12 or in 2 weeks.",
    });
  });
});

describe("today from the daemon's clock", () => {
  it("advances by wall time since the anchor arrived", () => {
    expect(todayOf(sunday, 90 * 60_000)).toEqual({ date: "2026-10-25", minute: 10 * 60 + 30 });
  });

  it("rolls over at local midnight", () => {
    expect(todayOf({ date: "2026-10-25", minute: 23 * 60 + 59 }, 2 * 60_000)).toEqual({
      date: "2026-10-26",
      minute: 1,
    });
  });
});

describe("labels", () => {
  it.each([
    ["2026-10-30", { over: false, text: "Due Oct 30" }],
    ["2026-10-25", { over: false, text: "Due Oct 25" }],
    ["2026-10-24", { over: true, text: "Due Oct 24 · 1 day over" }],
    ["2026-10-23", { over: true, text: "Due Oct 23 · 2 days over" }],
  ])("due %s", (due, flag) => {
    expect(dueFlag(due, sunday.date)).toEqual(flag);
  });

  it.each([
    [{ _tag: "Tray" } as const, "In the Tray"],
    [day("2026-10-29"), "Planned Thu"],
    [day("2026-10-26"), "Planned tomorrow"],
    [day("2026-10-20"), "Planned today"],
    [day("2026-11-12"), "Planned Nov 12"],
    [slot("2026-10-29", 15 * 60), "Planned Thu 15:00"],
  ])("plan %#", (plan, label) => {
    expect(planLabel(plan, sunday.date)).toBe(label);
  });
});
