import { describe, expect, it } from "vitest";
import { type Command, type Event, open, type State, seen, step } from "./ReadRule.ts";

const opened = (overrides: Partial<State> = {}): State => ({
  ...open({ seen: 9, last: 25, focused: true, visible: true }),
  ...overrides,
});

const run = (start: State, events: ReadonlyArray<Event>) =>
  events.reduce<{ state: State; commands: Array<Command["_tag"] | number> }>(
    ({ state, commands }, event) => {
      const [next, command] = step(state, event);
      return {
        state: next,
        commands: [...commands, command._tag === "Send" ? command.seq : command._tag],
      };
    },
    { state: start, commands: [] },
  );

const viewport = (inView: number): Event => ({ _tag: "Viewport", inView });
const input: Event = { _tag: "Input" };
const focus = (focused: boolean): Event => ({ _tag: "Focus", focused });
const visibility = (visible: boolean): Event => ({ _tag: "Visibility", visible });
const elapsed: Event = { _tag: "Elapsed" };
const leave: Event = { _tag: "Leave" };
const acked = (seq: number): Event => ({ _tag: "Acked", seq });
const failed = (seq: number): Event => ({ _tag: "Failed", seq });
const pause = (from: number | null = null): Event => ({ _tag: "Pause", from });
const resume: Event = { _tag: "Resume" };

describe("read rule", () => {
  it.each<{
    name: string;
    start?: Partial<State>;
    events: ReadonlyArray<Event>;
    commands: ReadonlyArray<Command["_tag"] | number>;
  }>([
    {
      name: "opening marks nothing while blocks are in view",
      events: [viewport(25), viewport(18)],
      commands: ["Idle", "Idle"],
    },
    {
      name: "a scroll input arms and re-checks what is already in view",
      events: [viewport(25), input],
      commands: ["Idle", 25],
    },
    {
      name: "regaining focus arms and re-checks",
      events: [viewport(25), focus(false), focus(true)],
      commands: ["Idle", "Idle", 25],
    },
    {
      name: "losing focus does not arm",
      events: [viewport(25), focus(false)],
      commands: ["Idle", "Idle"],
    },
    {
      name: "a partial read debounces and the timer sends it",
      events: [input, viewport(12), viewport(18), elapsed],
      commands: ["Idle", "Debounce", "Debounce", 18],
    },
    {
      name: "reaching the last seq sends at once",
      events: [input, viewport(12), viewport(25)],
      commands: ["Idle", "Debounce", 25],
    },
    {
      name: "leaving flushes a pending read",
      events: [input, viewport(12), leave],
      commands: ["Idle", "Debounce", 12],
    },
    {
      name: "hiding the tab flushes a pending read",
      events: [input, viewport(12), visibility(false)],
      commands: ["Idle", "Debounce", 12],
    },
    {
      name: "a hidden tab advances nothing even with blocks in view",
      start: { visible: false },
      events: [input, viewport(25), elapsed, leave],
      commands: ["Idle", "Idle", "Idle", "Idle"],
    },
    {
      name: "an unfocused tab advances nothing until focus returns",
      start: { focused: false },
      events: [input, viewport(25), focus(true)],
      commands: ["Idle", "Idle", 25],
    },
    {
      name: "a visible again tab sends once the reader is armed",
      start: { visible: false },
      events: [viewport(25), visibility(true), input],
      commands: ["Idle", "Idle", 25],
    },
    {
      name: "paused never advances",
      start: { mode: { _tag: "Paused", seen: 24 } },
      events: [input, viewport(25), focus(true), leave],
      commands: ["Idle", "Idle", "Idle", "Idle"],
    },
    {
      name: "marking unread drops a pending read and sends nothing until the conversation closes",
      events: [input, viewport(12), pause(), viewport(25), elapsed, focus(true), leave],
      commands: ["Idle", "Debounce", "Unread", "Idle", "Idle", "Idle", "Idle"],
    },
    {
      name: "new messages that arrive after Mark unread are not read either",
      events: [input, viewport(25), pause(), { _tag: "Grown", last: 30 }, viewport(30), leave],
      commands: ["Idle", 25, "Unread", "Idle", "Idle", "Idle"],
    },
    {
      name: "a mark unread that fails resumes reading",
      events: [input, pause(), viewport(25), resume],
      commands: ["Idle", "Unread", "Idle", 25],
    },
    {
      name: "scrolling back up never sends a lower seq",
      events: [input, viewport(18), elapsed, viewport(12), elapsed, leave],
      commands: ["Idle", "Debounce", 18, "Idle", "Idle", "Idle"],
    },
    {
      name: "a read in flight is not sent twice",
      events: [input, viewport(18), elapsed, elapsed, leave],
      commands: ["Idle", "Debounce", 18, "Idle", "Idle"],
    },
    {
      name: "a failed read is sent again on the next trigger",
      events: [input, viewport(18), elapsed, failed(18), leave, acked(18), leave],
      commands: ["Idle", "Debounce", 18, "Idle", 18, "Idle", "Idle"],
    },
    {
      name: "a failed partial read debounces again on the next eligible event",
      events: [input, viewport(18), elapsed, failed(18), viewport(18), elapsed],
      commands: ["Idle", "Debounce", 18, "Idle", "Debounce", 18],
    },
    {
      name: "a failed partial read waits while the window is unfocused",
      events: [input, viewport(18), elapsed, failed(18), focus(false), input, focus(true), elapsed],
      commands: ["Idle", "Debounce", 18, "Idle", "Idle", "Idle", "Debounce", 18],
    },
    {
      name: "a failed full read waits for the next trigger instead of retrying at once",
      events: [input, viewport(25), failed(25), input, acked(25), input],
      commands: ["Idle", 25, "Idle", 25, "Idle", "Idle"],
    },
    {
      name: "nothing at or below the seen seq is ever sent",
      events: [input, viewport(5), elapsed, leave],
      commands: ["Idle", "Idle", "Idle", "Idle"],
    },
    {
      name: "new items make an earlier full read partial again",
      events: [input, viewport(25), { _tag: "Grown", last: 30 }, viewport(30)],
      commands: ["Idle", 25, "Idle", 30],
    },
  ])("$name", ({ start, events, commands }) => {
    expect(run(opened(start), events).commands).toEqual(commands);
  });

  it("sent only ever grows", () => {
    const { state } = run(opened(), [input, viewport(18), elapsed, acked(18), viewport(12), leave]);
    expect(state).toMatchObject({ candidate: 18, sent: 18, pending: 0, armed: true });
  });

  it("the sent seq advances only after the read is acknowledged", () => {
    const sent = run(opened(), [input, viewport(18), elapsed]).state;
    expect(sent.sent).toBe(9);
    const failedOnce = run(sent, [failed(18)]).state;
    expect(failedOnce.sent).toBe(9);
    const retried = run(failedOnce, [leave, acked(18)]);
    expect(retried.commands).toEqual([18, "Idle"]);
    expect(retried.state.sent).toBe(18);
  });

  it.each([
    ["Mark unread leaves the last message unread", null, 24],
    ["Mark unread from here leaves that message and later ones unread", 12, 11],
    ["Mark unread from the first message leaves nothing read", 1, 0],
  ])("%s", (_, from, expected) => {
    const { state } = run(opened(), [input, viewport(25), pause(from)]);
    expect(seen(state)).toBe(expected);
  });

  it("Mark unread sends the last seq shown when clicked, not whatever is last when it lands", () => {
    const [, command] = step(run(opened(), [input, viewport(25)]).state, pause());
    expect(command).toEqual({ _tag: "Unread", from: 25 });
  });

  it("seen follows reading until paused", () => {
    expect(seen(run(opened(), [input, viewport(18)]).state)).toBe(18);
  });
});
