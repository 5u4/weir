export type Pause = { readonly id: number; readonly seen: number };

export type Mode =
  | { readonly _tag: "Reading" }
  | { readonly _tag: "Paused"; readonly pauses: readonly [Pause, ...Array<Pause>] };

export type State = {
  readonly candidate: number;
  readonly sent: number;
  readonly pending: number;
  readonly last: number;
  readonly inView: number;
  readonly armed: boolean;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly mode: Mode;
  readonly issued: number;
};

export type Event =
  | { readonly _tag: "Viewport"; readonly inView: number }
  | { readonly _tag: "Input" }
  | { readonly _tag: "Focus"; readonly focused: boolean }
  | { readonly _tag: "Visibility"; readonly visible: boolean }
  | { readonly _tag: "Fetched"; readonly last: number; readonly seen: number }
  | { readonly _tag: "Elapsed" }
  | { readonly _tag: "Leave" }
  | { readonly _tag: "Acked"; readonly seq: number }
  | { readonly _tag: "Failed"; readonly seq: number }
  | { readonly _tag: "Pause"; readonly from: number | null }
  | { readonly _tag: "Resume"; readonly pause: number };

export type Command =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Debounce" }
  | { readonly _tag: "Send"; readonly seq: number }
  | { readonly _tag: "Unread"; readonly from: number; readonly pause: number };

export const open = (opened: {
  readonly seen: number;
  readonly last: number;
  readonly focused: boolean;
  readonly visible: boolean;
}): State => ({
  candidate: opened.seen,
  sent: opened.seen,
  pending: 0,
  last: opened.last,
  inView: 0,
  armed: false,
  focused: opened.focused,
  visible: opened.visible,
  mode: { _tag: "Reading" },
  issued: 0,
});

const apply = (state: State, event: Event): State => {
  switch (event._tag) {
    case "Viewport":
      return { ...state, inView: event.inView };
    case "Input":
      return { ...state, armed: true };
    case "Focus":
      return { ...state, focused: event.focused, armed: state.armed || event.focused };
    case "Visibility":
      return { ...state, visible: event.visible };
    case "Fetched":
      return {
        ...state,
        last: event.last,
        candidate: Math.max(state.candidate, event.seen),
        sent: Math.max(state.sent, event.seen),
      };
    case "Acked":
      return {
        ...state,
        sent: Math.max(state.sent, event.seq),
        pending: state.pending === event.seq ? 0 : state.pending,
      };
    case "Failed":
      return { ...state, pending: state.pending === event.seq ? 0 : state.pending };
    case "Pause": {
      const pause = {
        id: state.issued,
        seen: Math.max(0, Math.min(event.from ?? state.last, state.last) - 1),
      };
      const held = state.mode._tag === "Paused" ? state.mode.pauses : [];
      return {
        ...state,
        issued: state.issued + 1,
        mode: { _tag: "Paused", pauses: [pause, ...held] },
      };
    }
    case "Resume": {
      if (state.mode._tag === "Reading") return state;
      const [first, ...rest] = state.mode.pauses.filter(({ id }) => id !== event.pause);
      return {
        ...state,
        mode:
          first === undefined ? { _tag: "Reading" } : { _tag: "Paused", pauses: [first, ...rest] },
      };
    }
    case "Elapsed":
    case "Leave":
      return state;
  }
};

const flushes = (event: Event) =>
  event._tag === "Elapsed" ||
  event._tag === "Leave" ||
  (event._tag === "Visibility" && !event.visible);

export const step = (state: State, event: Event): readonly [State, Command] => {
  const applied = apply(state, event);
  if (event._tag === "Pause") {
    return [applied, { _tag: "Unread", from: event.from ?? applied.last, pause: state.issued }];
  }
  if (event._tag === "Acked" || event._tag === "Failed" || applied.mode._tag === "Paused") {
    return [applied, { _tag: "Idle" }];
  }
  const eligible = applied.armed && applied.focused && applied.visible;
  const next = eligible
    ? { ...applied, candidate: Math.max(applied.candidate, applied.inView) }
    : applied;
  const covered = Math.max(next.sent, next.pending);
  if (next.candidate > covered && (flushes(event) || next.candidate >= next.last)) {
    return [
      { ...next, pending: next.candidate },
      { _tag: "Send", seq: next.candidate },
    ];
  }
  return [next, eligible && next.candidate > covered ? { _tag: "Debounce" } : { _tag: "Idle" }];
};

export const seen = (state: State) =>
  state.mode._tag === "Paused" ? state.mode.pauses[0].seen : state.candidate;
