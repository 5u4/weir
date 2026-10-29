import { Api, View as ApiView, ClearableView, Event, type Row } from "@weir/daemon/Api";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Digest from "./Digest.ts";
import { refetches } from "./Live.ts";
import { type ConversationId, route, statusOpen, type View } from "./Route.ts";
import { type Intents, intentFor } from "./Rows.ts";

export class Weir extends AtomHttpApi.Service<Weir>()("Weir", {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl: location.origin,
}) {}

const statusSnapshot = Weir.query("weir", "status", {});

export const status = Atom.transform(
  statusSnapshot,
  (get) => {
    get.subscribe(statusOpen, (open) => {
      if (open) get.refresh(statusSnapshot);
    });
    get.subscribe(statusSnapshot, (value) => get.setSelf(value));
    return get.once(statusSnapshot);
  },
  { initialValueTarget: statusSnapshot },
);

export const reload = Weir.runtime.fn<void>()(
  Effect.fnUntraced(function* (_, get) {
    const client = yield* Weir;
    yield* client.reload({}).pipe(Effect.catchTag("ConfigInvalid", () => Effect.void));
    get.refresh(statusSnapshot);
    yield* get.result(statusSnapshot, { suspendOnWaiting: true });
  }),
  { reactivityKeys: ["counts", "list"] },
);

export const searchOpen = Atom.make(false);

export const counts = Weir.query("view", "counts", { reactivityKeys: ["counts"] });

export const tagOrder = Atom.make((get) =>
  AsyncResult.getOrElse(
    AsyncResult.map(get(counts), (value) => value.tags.map(({ name }) => name)),
    (): ReadonlyArray<string> => [],
  ),
);

const toApiView = Schema.decodeSync(ApiView);
const toClearableView = Schema.decodeSync(ClearableView);

export const viewList = Atom.family((view: View) =>
  Weir.query("view", "conversations", {
    query: { view: toApiView(view) },
    reactivityKeys: ["list"],
  }),
);

export const conversation = Atom.family((id: ConversationId) =>
  Weir.query("weir", "conversation", {
    params: { id },
    reactivityKeys: { conversation: [id] },
  }),
);

class Disconnected extends Data.TaggedError("Disconnected") {}

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Event));

const events = Stream.callback<string, Disconnected>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const source = new EventSource(new URL("/events", location.origin));
      source.addEventListener("message", ({ data }: MessageEvent<string>) => {
        Queue.offerUnsafe(queue, data);
      });
      source.addEventListener("error", () => {
        Queue.failCauseUnsafe(queue, Cause.fail(new Disconnected()));
      });
      return source;
    }),
    (source) => Effect.sync(() => source.close()),
  ),
).pipe(
  Stream.mapEffect((data) => decodeEvent(data)),
  Stream.retry(Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("10 seconds")])),
);

type Runs = ReadonlyMap<number, Digest.Run>;

const digestRuns = Atom.make<Runs>(new Map()).pipe(Atom.keepAlive);

const withRun = (runs: Runs, id: number, run: Digest.Run): Runs =>
  changed(runs, id, run._tag === "Idle" ? undefined : run);

export const digestRun = Atom.family((id: ConversationId) =>
  Atom.make((get) => {
    const local = get(digestRuns).get(id) ?? Digest.idle;
    const detail = get(conversation(id));
    return AsyncResult.isSuccess(detail)
      ? Digest.seeded(
          local,
          detail.value.digest.last_failure,
          detail.value.items,
          detail.value.digests,
        )
      : local;
  }),
);

export const live = Weir.runtime.atom((get) =>
  Stream.runForEach(events, (event) =>
    Effect.gen(function* () {
      const open = get.registry.get(route).conversation;
      const refetch = refetches(event, open);
      if (event.type === "digest") {
        get.registry.update(digestRuns, (runs) =>
          withRun(
            runs,
            event.conversation_id,
            Digest.observe(runs.get(event.conversation_id) ?? Digest.idle, event),
          ),
        );
      }
      if (refetch.status) get.registry.refresh(statusSnapshot);
      if (event.type === "ready") {
        const snapshot = yield* Effect.option(
          AtomRegistry.getResult(get.registry, statusSnapshot, { suspendOnWaiting: true }),
        );
        const running = new Map(
          Option.match(snapshot, {
            onNone: () => [],
            onSome: ({ digest }) =>
              (digest?.running ?? []).map((job) => [job.conversation_id, job] as const),
          }),
        );
        get.registry.update(
          digestRuns,
          (runs) =>
            new Map(
              [...new Set([...runs.keys(), ...running.keys()])].flatMap((id) => {
                const next = Digest.reconciled(runs.get(id) ?? Digest.idle, running.get(id));
                return next._tag === "Idle" ? [] : [[id, next] as const];
              }),
            ),
        );
      }
      yield* Reactivity.invalidate([
        ...(refetch.counts ? ["counts"] : []),
        ...(refetch.list ? ["list"] : []),
      ]);
      if (refetch.conversation && Option.isSome(open)) {
        yield* Reactivity.invalidate({ conversation: [open.value] });
      }
    }),
  ),
);

export const runDigest = Weir.runtime
  .fn<{
    readonly id: ConversationId;
    readonly action: Digest.Action;
    readonly range: Digest.Range;
    readonly items: number;
    readonly land: (digests: ReadonlyArray<number>) => () => void;
  }>()(
    ({ id, action, range, items, land }, get) =>
      Effect.gen(function* () {
        if (get.registry.get(digestRun(id))._tag === "Running") return;
        const client = yield* Weir;
        const settle = (run: Digest.Run) =>
          get.registry.update(digestRuns, (runs) => withRun(runs, id, run));
        settle({ _tag: "Running", range, origin: { _tag: "Tab", action } });
        const request =
          action._tag === "Redo"
            ? client.redo({ params: { id: action.id } })
            : client.digest({ params: { id }, payload: Digest.payload(action) });
        const outcome = yield* request.pipe(
          Effect.map(({ digests }) => ({ _tag: "Landed" as const, digests })),
          Effect.catch((error) => Effect.succeed(Digest.cause(error))),
        );
        if (outcome._tag !== "Landed") {
          const failed: Digest.Run = { _tag: "Failed", action, range, items, cause: outcome };
          settle(failed);
          if (action._tag !== "From") return;
          yield* Reactivity.invalidate({ conversation: [id] });
          const detail = yield* Effect.option(
            get.result(conversation(id), { suspendOnWaiting: true }),
          );
          if (Option.isNone(detail)) return;
          const { items: fresh, digests } = detail.value;
          get.registry.update(digestRuns, (runs) =>
            runs.get(id) === failed
              ? withRun(runs, id, Digest.reanchored(failed, fresh, digests))
              : runs,
          );
          return;
        }
        const release = land(outcome.digests.map((digest) => digest.id));
        yield* Reactivity.invalidate(["list"]);
        yield* Reactivity.invalidate({ conversation: [id] });
        yield* Effect.ignore(get.result(conversation(id), { suspendOnWaiting: true }));
        settle(Digest.idle);
        yield* Effect.callback<void>((resume) => {
          requestAnimationFrame(() => resume(Effect.void));
        });
        release();
      }),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive);

export const intents = Atom.make<Intents>(new Map()).pipe(Atom.keepAlive);

const changed = <A>(map: ReadonlyMap<number, A>, id: number, value: A | undefined) => {
  const next = new Map(map);
  if (value === undefined) next.delete(id);
  else next.set(id, value);
  return next;
};

export const dismiss = Weir.runtime
  .fn<{ readonly view: View; readonly row: Row }>()(
    ({ view, row }, get) =>
      Effect.gen(function* () {
        const client = yield* Weir;
        const before = get.registry.get(intents).get(row.id);
        const intent = intentFor(view, row);
        get.registry.update(intents, (map) => changed(map, row.id, intent));
        const request =
          view === "cleared"
            ? client.restore({ params: { id: row.id } })
            : client.done({ params: { id: row.id }, payload: { seq: row.last_seq } });
        yield* request.pipe(
          Effect.onError(() =>
            Effect.sync(() => get.registry.update(intents, (map) => changed(map, row.id, before))),
          ),
        );
        yield* Reactivity.invalidate(["counts", "list"]);
        yield* Effect.ignore(get.result(viewList(view), { suspendOnWaiting: true }));
        get.registry.update(intents, (map) =>
          map.get(row.id) === intent ? changed(map, row.id, undefined) : map,
        );
      }),
    { concurrent: true },
  )
  .pipe(Atom.keepAlive);

export const clearAll = Weir.runtime
  .fn<{
    readonly view: Exclude<View, "cleared">;
    readonly seq: number;
    readonly ids: ReadonlyArray<number>;
  }>()(
    ({ view, seq, ids }, get) =>
      Effect.gen(function* () {
        const client = yield* Weir;
        yield* client.clear({ payload: { view: toClearableView(view), seq } });
        get.registry.update(intents, (map) =>
          ids.reduce<Intents>((next, id) => changed(next, id, undefined), map),
        );
      }),
    { reactivityKeys: ["counts", "list"] },
  )
  .pipe(Atom.keepAlive);

export const tabTitle = Atom.make((get) => {
  const unread = AsyncResult.getOrElse(
    AsyncResult.map(get(counts), (value) => value.unread),
    () => 0,
  );
  document.title = unread > 0 ? `(${unread}) weir` : "weir";
  return unread;
});
