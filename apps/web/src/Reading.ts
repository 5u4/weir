import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";
import { closedUi, type Detail, lastSeq, type ReaderUi, type TopicKey } from "./Blocks.ts";
import type { Range } from "./Digest.ts";
import { type DockAction, dockActions } from "./Dock.ts";
import { type Hit, hitKey, hits, matchedIn, reveal } from "./Hits.ts";
import * as ReadRule from "./ReadRule.ts";
import type { ConversationId } from "./Route.ts";
import type { Target } from "./Rows.ts";
import { conversation, inTurn, intents, searchPattern, Weir } from "./Weir.ts";

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
        yield* inTurn(id)(client.read({ params: { id }, payload: { seq } }));
      }).pipe(Effect.onExit((exit) => Effect.sync(() => settled(Exit.isSuccess(exit))))),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive);

export const markUnread = Weir.runtime
  .fn<{
    readonly id: ConversationId;
    readonly from: number;
    readonly failed: () => void;
  }>()(
    ({ id, from, failed }) =>
      Effect.gen(function* () {
        const client = yield* Weir;
        yield* inTurn(id)(client.unread({ params: { id }, payload: { seq: from } }));
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
            failed: () => dispatch({ _tag: "Resume", pause: command.pause }),
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
        dispatch({
          _tag: "Fetched",
          last: lastSeq(result.value),
          seen: result.value.state.seen_seq,
        });
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

export type Preview =
  | { readonly _tag: "Hover"; readonly range: Range }
  | { readonly _tag: "Tap"; readonly seq: number; readonly range: Range | null }
  | null;

export const preview = Atom.make<Preview>(null);

export const searchHits = Atom.family((id: ConversationId) =>
  Atom.make((get): Option.Option<ReadonlyArray<Hit>> => {
    const detail = get(conversation(id));
    return AsyncResult.isSuccess(detail)
      ? Option.some(hits(detail.value, get(searchPattern)))
      : Option.none();
  }),
);

export const searchMatchedIn = Atom.family((id: ConversationId) =>
  Atom.make((get): Option.Option<string> => {
    const detail = get(conversation(id));
    return AsyncResult.isSuccess(detail)
      ? Option.some(matchedIn(detail.value, get(searchPattern)))
      : Option.none();
  }),
);

const hitCursor = Atom.family((_: ConversationId) =>
  Atom.make<{ readonly key: string | null; readonly at: number }>({ key: null, at: 0 }).pipe(
    Atom.setIdleTTL(0),
  ),
);

export const hitAt = Atom.family((id: ConversationId) =>
  Atom.make((get) => {
    const found = Option.getOrElse(get(searchHits(id)), () => []);
    const { key, at } = get(hitCursor(id));
    const kept = found.findIndex((hit) => hitKey(hit) === key);
    return kept !== -1 ? kept : Math.max(0, Math.min(at, found.length - 1));
  }),
);

const scrollToHit = (key: string, smooth: boolean) =>
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`.reader [data-hit="${key}"]`);
    const scroller = target?.closest(".r-scroll");
    if (target == null || scroller == null) return;
    const pin =
      target.closest(".unf") === null
        ? null
        : (target.closest(".tp:not(.solo)") ?? target.closest(".dc"))?.querySelector(".pin");
    const anchor = target.matches(".tp.solo")
      ? (target.closest(".dc") ?? target)
      : target.previousElementSibling?.matches(".g-head")
        ? (target.closest(".sg") ?? target)
        : target;
    const view = scroller.getBoundingClientRect();
    const top =
      anchor.getBoundingClientRect().top -
      view.top -
      (pin?.getBoundingClientRect().height ?? 0) -
      24;
    const mark = target.querySelector("mark")?.getBoundingClientRect();
    scroller.scrollTo({
      top:
        scroller.scrollTop +
        (mark !== undefined && mark.bottom - top > view.bottom - 24
          ? mark.top - view.top - view.height / 2
          : top),
      behavior:
        smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto",
    });
  });

export const jumpTo = Atom.writable(
  () => undefined,
  (
    ctx,
    {
      id,
      at,
      smooth,
    }: { readonly id: ConversationId; readonly at: number; readonly smooth: boolean },
  ) => {
    const detail = ctx.get(conversation(id));
    const hit = Option.getOrElse(ctx.get(searchHits(id)), () => [])[at];
    if (!AsyncResult.isSuccess(detail) || hit === undefined) return;
    ctx.set(hitCursor(id), { key: hitKey(hit), at });
    ctx.set(readerUi(id), reveal(ctx.get(readerUi(id)), detail.value, hit));
    scrollToHit(hitKey(hit), smooth);
  },
);

export const stepHit = Atom.writable(
  () => undefined,
  (ctx, { id, by }: { readonly id: ConversationId; readonly by: 1 | -1 }) =>
    ctx.set(jumpTo, { id, at: ctx.get(hitAt(id)) + by, smooth: true }),
);

export const landing = Atom.family((id: ConversationId) =>
  Atom.make((get) => {
    let landed = false;
    get.subscribe(
      searchHits(id),
      (found) => {
        if (Option.isNone(found)) return;
        const smooth = landed;
        landed = true;
        const { key, at } = get.once(hitCursor(id));
        if (found.value.length === 0) return;
        const kept = found.value.findIndex((hit) => hitKey(hit) === key);
        if (kept !== -1) {
          if (kept !== at) get.registry.set(hitCursor(id), { key, at: kept });
          return;
        }
        queueMicrotask(() =>
          get.registry.set(jumpTo, { id, at: get.registry.get(hitAt(id)), smooth }),
        );
      },
      { immediate: true },
    );
  }).pipe(Atom.setIdleTTL(0)),
);
