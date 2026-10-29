import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";
import { closedUi, type Detail, lastSeq, type ReaderUi, type TopicKey } from "./Blocks.ts";
import type { Range } from "./Digest.ts";
import { type DockAction, dockActions } from "./Dock.ts";
import * as ReadRule from "./ReadRule.ts";
import type { ConversationId } from "./Route.ts";
import type { Target } from "./Rows.ts";
import { conversation, intents, Weir } from "./Weir.ts";

const debounce = 300;

export const markRead = Weir.runtime
  .fn<{
    readonly id: ConversationId;
    readonly seq: number;
    readonly settled: (acked: boolean) => void;
  }>()(
    ({ id, seq, settled }) =>
      Effect.gen(function* () {
        const client = yield* Weir;
        yield* client.read({ params: { id }, payload: { seq } });
      }).pipe(Effect.onExit((exit) => Effect.sync(() => settled(Exit.isSuccess(exit))))),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive);

export const markUnread = Weir.runtime
  .fn<{
    readonly id: ConversationId;
    readonly from: number | null;
    readonly failed: () => void;
  }>()(
    ({ id, from, failed }) =>
      Effect.gen(function* () {
        const client = yield* Weir;
        yield* client.unread({ params: { id }, payload: from === null ? {} : { seq: from } });
        yield* Reactivity.invalidate(["counts", "list"]);
        yield* Reactivity.invalidate({ conversation: [id] });
      }).pipe(Effect.onError(() => Effect.sync(failed))),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive);

export type Reading = {
  readonly frozen: Option.Option<number>;
  readonly seen: number;
  readonly dispatch: (event: ReadRule.Event) => void;
  readonly watch: (end: HTMLElement) => () => void;
  readonly unread: (from: number | null) => void;
};

const visibleNow = () => document.visibilityState === "visible";

export const reading = Atom.family((id: ConversationId) =>
  Atom.make((get): Reading => {
    let opened = Option.none<{ readonly frozen: number; rule: ReadRule.State }>();
    let timer: number | undefined;
    const publish = (change: Partial<Reading>) =>
      Option.map(get.self<Reading>(), (value) => get.setSelf({ ...value, ...change }));
    const inView = new Map<Element, number>();
    const highest = () => Math.max(0, ...inView.values());

    const stop = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const dispatch = (event: ReadRule.Event) => {
      if (Option.isNone(opened)) return;
      const current = opened.value;
      const [rule, command] = ReadRule.step(current.rule, event);
      const advanced = ReadRule.seen(rule) !== ReadRule.seen(current.rule);
      current.rule = rule;
      switch (command._tag) {
        case "Debounce":
          stop();
          timer = window.setTimeout(() => dispatch({ _tag: "Elapsed" }), debounce);
          break;
        case "Send":
          stop();
          get.registry.set(markRead, {
            id,
            seq: command.seq,
            settled: (acked) => dispatch({ _tag: acked ? "Acked" : "Failed", seq: command.seq }),
          });
          break;
        case "Unread":
          get.registry.set(markUnread, {
            id,
            from: command.from,
            failed: () => dispatch({ _tag: "Resume" }),
          });
          break;
        case "Idle":
          break;
      }
      if (advanced) publish({ seen: ReadRule.seen(rule) });
    };
    const unread = (from: number | null) => dispatch({ _tag: "Pause", from });

    const observer = new IntersectionObserver((entries) => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting && target instanceof HTMLElement) {
          inView.set(target, Number(target.dataset.seq));
        } else inView.delete(target);
      }
      dispatch({ _tag: "Viewport", inView: highest() });
    });
    const watch = (end: HTMLElement) => {
      observer.observe(end);
      return () => {
        observer.unobserve(end);
        inView.delete(end);
        dispatch({ _tag: "Viewport", inView: highest() });
      };
    };

    const open = (detail: Detail) => {
      const seen = detail.state.seen_seq;
      opened = Option.some({
        frozen: seen,
        rule: {
          ...ReadRule.open({
            seen,
            last: lastSeq(detail),
            focused: document.hasFocus(),
            visible: visibleNow(),
          }),
          inView: highest(),
        },
      });
      return seen;
    };
    const initial = get.once(conversation(id));
    const frozen = AsyncResult.isSuccess(initial)
      ? Option.some(open(initial.value))
      : Option.none();
    get.subscribe(conversation(id), (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      if (Option.isSome(opened)) {
        dispatch({ _tag: "Grown", last: lastSeq(result.value) });
        return;
      }
      const seen = open(result.value);
      publish({ frozen: Option.some(seen), seen });
    });

    const onFocus = () => dispatch({ _tag: "Focus", focused: true });
    const onBlur = () => dispatch({ _tag: "Focus", focused: false });
    const onVisibility = () => dispatch({ _tag: "Visibility", visible: visibleNow() });
    addEventListener("focus", onFocus);
    addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    get.addFinalizer(() => {
      dispatch({ _tag: "Leave" });
      stop();
      observer.disconnect();
      removeEventListener("focus", onFocus);
      removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    });

    return { frozen, seen: Option.getOrElse(frozen, () => 0), dispatch, watch, unread };
  }).pipe(Atom.setIdleTTL(0)),
);

export type Dock = {
  readonly actions: ReadonlyArray<DockAction>;
  readonly target: Target;
  readonly open: Detail["open"];
};

export const dock = Atom.family((id: ConversationId) =>
  Atom.make((get): Option.Option<Dock> => {
    const detail = get(conversation(id));
    if (!AsyncResult.isSuccess(detail)) return Option.none();
    const last = lastSeq(detail.value);
    const intent = get(intents).get(id);
    const state =
      intent === undefined
        ? detail.value.state.state
        : intent._tag === "Done"
          ? "done"
          : intent._tag === "Mute"
            ? "muted"
            : "read";
    return Option.some({
      actions: dockActions({ state, read: get(reading(id)).seen >= last }),
      target: { id, last_seq: last, cleared_seq: detail.value.state.cleared_seq },
      open: detail.value.open,
    });
  }),
);

export const readerUi = Atom.family((_: ConversationId) =>
  Atom.make<ReaderUi>(closedUi).pipe(Atom.setIdleTTL(0)),
);

export const pins = Atom.family((_: ConversationId) =>
  Atom.make<ReadonlyMap<TopicKey, number>>(new Map()).pipe(Atom.setIdleTTL(0)),
);

export type Preview = { readonly range: Range; readonly tapped: boolean } | null;

export const preview = Atom.make<Preview>(null);
