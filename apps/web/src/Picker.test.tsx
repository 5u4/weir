// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react/RegistryContext";
import type { Meeting } from "@weir/daemon/Api";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Detail } from "./Blocks.ts";
import { Picker } from "./Picker.tsx";
import { dock } from "./Reading.ts";
import { ConversationId, home } from "./Route.ts";
import { conversation, meetings, picker, planRows, today, zone } from "./Weir.ts";

vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", () => Promise.withResolvers<Response>().promise);
});

const id = ConversationId.make(7);
const monday = "2026-10-26";
const tuesday = "2026-10-27";

const detail: Detail = {
  id,
  source: "gmail",
  title: "Northwind",
  first_at: "2026-10-20T09:00:00.000Z",
  last_at: "2026-10-20T09:00:00.000Z",
  tags: [],
  open: null,
  state: {
    seen_seq: 0,
    cleared_seq: 0,
    muted: false,
    state: "unread",
    plan: { _tag: "None" },
    planned_at: null,
    due: null,
  },
  items: [],
  digests: [],
  digest: { backlog: null, earlier: [], now: null, last_failure: null },
};

type Loaded = AsyncResult.AsyncResult<ReadonlyArray<Meeting>, string>;

const opened = (loaded: Loaded) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <RegistryProvider
        initialValues={[
          [conversation(id), AsyncResult.success(detail)],
          [
            dock(id),
            Option.some({
              actions: [],
              state: "unread",
              target: { id, last_seq: 0, cleared_seq: 0 },
              open: null,
            }),
          ],
          [picker, Option.some({ id, tab: "plan", at: home })],
          [planRows, []],
          [today, Option.some({ date: monday, minute: 600 })],
          [zone, Option.some("America/Los_Angeles")],
          [meetings(`${monday}/${monday}`), loaded],
          [meetings(`${tuesday}/${tuesday}`), loaded],
        ]}
      >
        <Picker id={id} />
      </RegistryProvider>,
    ),
  );
  const choices = () =>
    [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent ?? "");
  const click = (selector: string) => act(() => host.querySelector<HTMLElement>(selector)?.click());
  return { choices, click, unmount: () => act(() => root.unmount()) };
};

const states: ReadonlyArray<readonly [string, Loaded]> = [
  ["still loading", AsyncResult.initial()],
  ["failed", AsyncResult.failure(Cause.fail("unreachable"))],
];

let unmount = () => {};
afterEach(() => {
  unmount();
  document.body.replaceChildren();
});

describe("picker while meetings are unknown", () => {
  it.each(states)(
    "meetings %s: Later today plans the day and promises no free time",
    (_, state) => {
      const picker = opened(state);
      unmount = picker.unmount;
      const later = picker.choices().find((choice) => choice.startsWith("Later today"));
      expect(later).toBe("Later todayToday · no set time");
    },
  );

  it.each(states)("meetings %s: a picked day offers only Any time", (_, state) => {
    const picker = opened(state);
    unmount = picker.unmount;
    picker.click('[role="option"]:last-child');
    picker.click('[aria-label="Tue Oct 27"]');
    expect(picker.choices()).toEqual(["Any timeThat day, no set time"]);
  });

  it("loaded meetings still offer free time", () => {
    const picker = opened(AsyncResult.success([]));
    unmount = picker.unmount;
    expect(picker.choices().find((choice) => choice.startsWith("Later today"))).toContain(
      "free the rest of the day",
    );
    picker.click('[role="option"]:last-child');
    picker.click('[aria-label="Tue Oct 27"]');
    expect(picker.choices()).toEqual([
      "Any timeThat day, no set time",
      expect.stringMatching(/ free$/),
    ]);
  });
});
