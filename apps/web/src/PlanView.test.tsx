import type { Row } from "@weir/daemon/Api";
import * as Option from "effect/Option";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { plannedRows } from "./PlanLayout.ts";
import { PlanCard } from "./PlanView.tsx";
import { home } from "./Route.ts";

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
