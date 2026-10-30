import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import { flushSync } from "react-dom";
import type { ConversationId } from "./Route.ts";

export type Scene = {
  readonly status: boolean;
  readonly conversation: Option.Option<ConversationId>;
};

export type Motion =
  | { readonly _tag: "None" }
  | { readonly _tag: "Mode"; readonly open: boolean }
  | { readonly _tag: "Switch" }
  | { readonly _tag: "StatusRise" };

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

type Gate =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Pending";
      readonly transition: ViewTransition;
      readonly queued: Array<() => Commit>;
    };

let gate: Gate = { _tag: "Idle" };

const morph = (open: boolean, after: Scene, apply: () => void) => {
  if (
    typeof document.startViewTransition !== "function" ||
    document.hidden ||
    matchMedia(reducedMotion).matches
  ) {
    return apply();
  }
  try {
    const transition = document.startViewTransition({
      update: async () => {
        flushSync(apply);
        if (!after.status && Option.isSome(after.conversation)) {
          await arrival(after.conversation.value, AbortSignal.timeout(arrivalLimitMs));
        }
        // The arrival only schedules React's store update; the new snapshot must include it.
        flushSync(() => undefined);
      },
      types: ["mode", open ? "open" : "close"],
    });
    const queued: Array<() => Commit> = [];
    gate = { _tag: "Pending", transition, queued };
    const drain = () => {
      gate = { _tag: "Idle" };
      for (const plan of queued) commit(plan);
    };
    transition.updateCallbackDone.then(drain, drain);
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

let commits = 0;

export const commit = (plan: () => Commit) => {
  if (gate._tag === "Pending") {
    gate.queued.push(plan);
    return;
  }
  commits += 1;
  const { before, after, apply, animate } = plan();
  const motion: Motion = animate ? motionOf(before, after) : { _tag: "None" };
  if (motion._tag === "Mode") return morph(motion.open, after, apply);
  if (motion._tag === "None" || matchMedia(reducedMotion).matches) return apply();
  flushSync(apply);
  if (motion._tag === "StatusRise") {
    return lift(document.querySelector(".r-scroll:not([hidden])"), "status");
  }
  if (Option.isNone(after.conversation)) return;
  const landed = commits;
  void arrival(after.conversation.value, AbortSignal.timeout(arrivalLimitMs)).then(() => {
    if (landed !== commits || gate._tag === "Pending") return;
    flushSync(() => undefined);
    lift(document.querySelector(".r-scroll:not([hidden]) > article"), "switch");
  });
};
