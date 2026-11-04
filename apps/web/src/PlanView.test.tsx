import { RegistryProvider } from "@effect/atom-react/RegistryContext";
import type { Row } from "@weir/daemon/Api";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { plannedRows } from "./PlanLayout.ts";
import { PlanBlock, PlanCard, PlanView } from "./PlanView.tsx";
import { home, route, type Scale } from "./Route.ts";
import { meetings, planList, today, zone } from "./Weir.ts";

vi.hoisted(() => vi.stubGlobal("location", { origin: "http://weir.test", search: "" }));

const row = (fresh: number): Row => ({
  id: 7,
  source: "gmail",
  title: "Northwind migration: cutover plan and UAT sign-off",
  tags: ["Me"],
  first_at: "2026-10-20T18:05:00.000Z",
  last_at: "2026-10-26T09:00:00.000Z",
  last_seq: 4,
  seen_seq: 4 - fresh,
  cleared_seq: 0,
  muted: false,
  state: "planned",
  new: fresh,
  items: 4,
  participants: 2,
  from: { name: "Rachel Lin", address: "rachel@northwind.example", me: false },
  preview: "Rachel: can we confirm the window?",
  senders: [],
  plan: { _tag: "Tray" },
  planned_at: "2026-10-24T16:00:00.000Z",
  due: null,
});

const text = (fresh: number) => {
  const [card] = plannedRows([row(fresh)], new Map());
  if (card === undefined) throw new Error("expected a planned row");
  return renderToStaticMarkup(
    <PlanCard
      row={card}
      to={{ ...home, mode: "plan", conversation: Option.none() }}
      date="2026-10-26"
      nowMs={Date.parse("2026-10-26T16:00:00.000Z")}
      selected={false}
    />,
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

describe("plan card", () => {
  it("a planned conversation that received a message shows 1 new", () => {
    expect(text(1)).toBe(
      "In tray 2 days Northwind migration: cutover plan and UAT sign-off Rachel Lin · gmail 1 new",
    );
  });

  it("shows no new count when everything is read", () => {
    expect(text(0)).not.toContain("new");
  });
});

const block = (due: string) => {
  const [card] = plannedRows(
    [
      {
        ...row(0),
        plan: { _tag: "Slot", date: "2026-10-26", start: 600, minutes: 60 },
        due: { date: due, by: { _tag: "User" } },
      },
    ],
    new Map(),
  );
  if (card === undefined || card.plan._tag !== "Slot") throw new Error("expected a slot row");
  return renderToStaticMarkup(
    <PlanBlock
      block={{
        _tag: "Plan",
        row: { ...card, plan: card.plan },
        start: 600,
        minutes: 60,
        solid: true,
        from: null,
        lane: 0,
        lanes: 1,
      }}
      at={{ ...home, mode: "plan", conversation: Option.none() }}
      date="2026-10-26"
      today="2026-10-26"
      selected={false}
      hands={{ drag: null, grab: () => {} }}
      inPlace={false}
    />,
  );
};

describe("plan block", () => {
  it("flags a past due date in the warn style", () => {
    const flag = /<span class="([^"]*)">Due [^<]*<\/span>/.exec(block("2026-10-23"));
    expect(flag?.[0]).toContain("Due Oct 23 · 3 days over");
    expect(flag?.[1]).toContain("text-warn");
  });

  it("shows a future due date without the warn style", () => {
    const flag = /<span class="([^"]*)">Due [^<]*<\/span>/.exec(block("2026-10-30"));
    expect(flag?.[0]).toContain("Due Oct 30");
    expect(flag?.[1]).not.toContain("warn");
  });
});

describe("plan view", () => {
  it("a plan list that never loaded says it failed instead of showing nothing planned", () => {
    const markup = renderToStaticMarkup(
      <RegistryProvider
        initialValues={[
          [planList, AsyncResult.failure(Cause.fail("unreachable"))],
          [today, Option.some({ date: "2026-10-26", minute: 600 })],
          [zone, Option.some("America/Los_Angeles")],
        ]}
      >
        <PlanView />
      </RegistryProvider>,
    )
      .replace(/<[^>]*>/g, " ")
      .replace(/&#x27;/g, "'");
    expect(markup).toContain("Can't load plans.");
    expect(markup).not.toContain("Nothing planned");
    expect(markup).not.toContain("Tray");
  });

  it.each([
    ["day", "2026-10-26/2026-10-26"],
    ["month", "2026-09-28/2026-11-08"],
  ] as const satisfies ReadonlyArray<readonly [Scale, string]>)(
    "the %s view says meetings failed instead of showing a day with none",
    (scale, range) => {
      const markup = renderToStaticMarkup(
        <RegistryProvider
          initialValues={[
            [route, { ...home, mode: "plan", scale }],
            [planList, AsyncResult.success({ seq: 1, conversations: [] })],
            [meetings(range), AsyncResult.failure(Cause.fail("unreachable"))],
            [today, Option.some({ date: "2026-10-26", minute: 600 })],
            [zone, Option.some("America/Los_Angeles")],
          ]}
        >
          <PlanView />
        </RegistryProvider>,
      )
        .replace(/<[^>]*>/g, " ")
        .replace(/&#x27;/g, "'");
      expect(markup).toContain("Can't load meetings.");
      expect(markup).not.toContain("Can't load plans.");
    },
  );
});
