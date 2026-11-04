import { RegistryProvider } from "@effect/atom-react/RegistryContext";
import type { EventDetail } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MeetingCard } from "./MeetingCard.tsx";
import { today, zone } from "./Weir.ts";

vi.hoisted(() => vi.stubGlobal("location", { origin: "http://weir.test", search: "" }));

const event = (overrides: Partial<EventDetail>): EventDetail => ({
  event_id: "uat",
  series_id: null,
  start: "2026-10-30T14:00:00-07:00",
  end: "2026-10-30T15:00:00-07:00",
  all_day: false,
  location: "Room 4",
  attendees: [{ name: "Rachel Lin", email: "rachel@northwind.example", response: "accepted" }],
  status: "confirmed",
  change: null,
  recurring: false,
  ...overrides,
});

const card = (detail: EventDetail) =>
  renderToStaticMarkup(
    <RegistryProvider
      initialValues={[
        [today, Option.some({ date: "2026-10-25", minute: 540 })],
        [zone, Option.some("America/Los_Angeles")],
      ]}
    >
      <MeetingCard seq={9} title="Northwind UAT review" event={detail} me={false} className="" />
    </RegistryProvider>,
  );

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("meeting card", () => {
  it("shows when, where and who", () => {
    expect(text(card(event({})))).toBe(
      "Oct 30 Northwind UAT review Fri Oct 30 · 14:00–15:00 Room 4 with Rachel Lin",
    );
  });

  it("a moved meeting strikes the old time", () => {
    const markup = card(
      event({
        change: {
          _tag: "Moved",
          from_start: "2026-10-29T10:00:00-07:00",
          from_end: "2026-10-29T11:00:00-07:00",
        },
      }),
    );
    expect(markup).toMatch(/Moved: <s[^>]*>Thu 10:00<\/s> → Fri 14:00/);
  });

  it("a relocated meeting strikes the old place", () => {
    const markup = card(event({ change: { _tag: "Relocated", from_location: "Fennel & Rye" } }));
    expect(markup).toMatch(/Moved: <s[^>]*>Fennel &amp; Rye<\/s> → Room 4/);
  });

  it("a cancelled meeting is labelled and struck through", () => {
    const markup = card(event({ status: "cancelled", change: { _tag: "Cancelled" } }));
    expect(text(markup)).toContain("Cancelled Northwind UAT review");
    expect(markup).toMatch(/<b class="[^"]*line-through[^"]*">Northwind UAT review<\/b>/);
  });
});
