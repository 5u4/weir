import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { flushSync } from "react-dom";
import type { ConversationId } from "./Route.ts";

export type Scene = {
  readonly status: boolean;
  readonly conversation: Option.Option<ConversationId>;
  readonly notch: string;
};

export type Motion =
  | { readonly _tag: "None" }
  | { readonly _tag: "Mode"; readonly open: boolean }
  | { readonly _tag: "Switch" }
  | { readonly _tag: "StatusRise" }
  | { readonly _tag: "Tick" };

const sheet = (scene: Scene) => scene.status || Option.isSome(scene.conversation);

const motions: ReadonlyArray<{
  readonly when: (before: Scene, after: Scene) => boolean;
  readonly motion: (after: Scene) => Motion;
}> = [
  {
    when: (before, after) => sheet(before) !== sheet(after),
    motion: (after) => ({ _tag: "Mode", open: sheet(after) }),
  },
  {
    when: (before, after) => sheet(after) && before.status !== after.status,
    motion: () => ({ _tag: "StatusRise" }),
  },
  {
    when: (before, after) =>
      !after.status && !Equal.equals(before.conversation, after.conversation),
    motion: () => ({ _tag: "Switch" }),
  },
  {
    when: (before, after) => before.notch !== after.notch,
    motion: () => ({ _tag: "Tick" }),
  },
];

export const motionOf = (before: Scene, after: Scene): Motion =>
  motions.find(({ when }) => when(before, after))?.motion(after) ?? { _tag: "None" };

export type Commit = {
  readonly before: Scene;
  readonly after: Scene;
  readonly apply: () => void;
  readonly animate: boolean;
};

type Arrival = (id: ConversationId, signal: AbortSignal) => Promise<void>;

const arrivalLimitMs = 300;

const noArrival: Arrival = () => Promise.resolve();

let arrival = noArrival;

export const awaitArrivals = (next: Arrival) => {
  arrival = next;
  return () => {
    arrival = noArrival;
  };
};

const reducedMotion = "(prefers-reduced-motion: reduce)";

type Queue = Array<() => Commit>;

type Gate =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Capturing";
      readonly transition: ViewTransition;
      readonly apply: () => void;
      readonly queued: Queue;
    }
  | { readonly _tag: "Arriving"; readonly queued: Queue }
  | { readonly _tag: "Playing" };

const idle: Gate = { _tag: "Idle" };

let gate: Gate = idle;

const inputs = ["keydown", "pointerdown", "beforeinput", "popstate"] as const;

const enter = (next: Gate) => {
  const capturing = next._tag === "Capturing";
  if ((gate._tag === "Capturing") !== capturing) {
    for (const type of inputs) {
      if (capturing) addEventListener(type, settle, true);
      else removeEventListener(type, settle, true);
    }
  }
  gate = next;
};

const updating = () => gate._tag === "Capturing" || gate._tag === "Arriving";

let afterUpdate: Array<() => void> = [];

const release = (next: Gate, queued: Queue) => {
  enter(next);
  for (const plan of queued) commit(plan);
  if (updating()) return;
  const waiting = afterUpdate;
  afterUpdate = [];
  for (const run of waiting) run();
};

const settle = () => {
  if (gate._tag !== "Capturing") return;
  const { transition, apply, queued } = gate;
  flushSync(apply);
  transition.skipTransition();
  release(idle, queued);
};

const play = (types: Array<string>, arriving: Option.Option<ConversationId>, apply: () => void) => {
  if (
    typeof document.startViewTransition !== "function" ||
    document.hidden ||
    matchMedia(reducedMotion).matches
  ) {
    return apply();
  }
  try {
    const queued: Queue = [];
    const updating: Gate = { _tag: "Arriving", queued };
    const playing: Gate = { _tag: "Playing" };
    const transition = document.startViewTransition({
      update: async () => {
        if (gate !== capturing) return;
        enter(updating);
        flushSync(apply);
        if (Option.isSome(arriving)) {
          await arrival(arriving.value, AbortSignal.timeout(arrivalLimitMs));
        }
        // The arrival only schedules React's store update; the new snapshot must include it.
        flushSync(() => undefined);
      },
      types,
    });
    const capturing: Gate = { _tag: "Capturing", transition, apply, queued };
    enter(capturing);
    const done = () => {
      if (gate === updating) release(playing, queued);
    };
    transition.updateCallbackDone.then(done, done);
    const over = () => {
      if (gate === playing) enter(idle);
    };
    transition.finished.then(over, over);
    transition.ready.catch(() => undefined);
  } catch {
    apply();
  }
};

const lift = (target: Element | null, rise: "switch" | "status") => {
  if (target === null) return;
  target.setAttribute("data-rise", rise);
  void Promise.allSettled(target.getAnimations().map(({ finished }) => finished)).then(() =>
    target.removeAttribute("data-rise"),
  );
};

let departures = 0;

export const commit = (plan: () => Commit) => {
  if (gate._tag === "Capturing" || (gate._tag === "Arriving" && gate.queued.length > 0)) {
    gate.queued.push(plan);
    return;
  }
  const { before, after, apply, animate } = plan();
  const motion: Motion = animate ? motionOf(before, after) : { _tag: "None" };
  if (gate._tag === "Arriving" && motion._tag !== "None") {
    gate.queued.push(plan);
    return;
  }
  if (before.status !== after.status || !Equal.equals(before.conversation, after.conversation)) {
    departures += 1;
  }
  if (motion._tag === "Mode") {
    return play(
      ["mode", motion.open ? "open" : "close"],
      after.status ? Option.none() : after.conversation,
      apply,
    );
  }
  if (motion._tag === "Tick") {
    return gate._tag === "Idle" ? play(["tick"], Option.none(), apply) : apply();
  }
  if (motion._tag === "None" || matchMedia(reducedMotion).matches) return apply();
  flushSync(apply);
  if (motion._tag === "StatusRise") {
    return lift(document.querySelector(".r-scroll:not([hidden])"), "status");
  }
  if (Option.isNone(after.conversation)) return;
  const departed = departures;
  const rise = () => {
    if (departed !== departures) return;
    if (updating()) {
      afterUpdate.push(rise);
      return;
    }
    flushSync(() => undefined);
    lift(document.querySelector(".r-scroll:not([hidden]) > article"), "switch");
  };
  void arrival(after.conversation.value, AbortSignal.timeout(arrivalLimitMs)).then(rise);
};
