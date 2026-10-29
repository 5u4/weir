export type State = {
  readonly candidate: number;
  readonly sent: number;
  readonly pending: number;
  readonly last: number;
  readonly inView: number;
  readonly armed: boolean;
  readonly focused: boolean;
  readonly visible: boolean;
  readonly paused: boolean;
};

export type Event =
  | { readonly _tag: "Viewport"; readonly inView: number }
  | { readonly _tag: "Input" }
  | { readonly _tag: "Focus"; readonly focused: boolean }
  | { readonly _tag: "Visibility"; readonly visible: boolean }
  | { readonly _tag: "Grown"; readonly last: number }
  | { readonly _tag: "Elapsed" }
  | { readonly _tag: "Leave" }
  | { readonly _tag: "Acked"; readonly seq: number }
  | { readonly _tag: "Failed"; readonly seq: number };

export type Command =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Debounce" }
  | { readonly _tag: "Send"; readonly seq: number };

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
  paused: false,
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
    case "Grown":
      return { ...state, last: event.last };
    case "Acked":
      return {
        ...state,
        sent: Math.max(state.sent, event.seq),
        pending: state.pending === event.seq ? 0 : state.pending,
      };
    case "Failed":
      return { ...state, pending: state.pending === event.seq ? 0 : state.pending };
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
  if (event._tag === "Acked" || event._tag === "Failed") return [applied, { _tag: "Idle" }];
  const eligible = applied.armed && applied.focused && applied.visible && !applied.paused;
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
