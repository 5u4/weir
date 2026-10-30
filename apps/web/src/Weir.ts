import { Api, View as ApiView, ClearableView, Event, type Row } from "@weir/daemon/Api";
import { termPattern } from "@weir/daemon/Match";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
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
import { capture, leave } from "./Flip.ts";
import { refetches } from "./Live.ts";
import { awaitArrivals } from "./Morph.ts";
import { parseQuery, sameParams, searchParams } from "./Query.ts";
import { narrowed, picked, type Result } from "./Results.ts";
import { ConversationId, route, statusOpen, type View } from "./Route.ts";
import {
  type Act,
  exits,
  type Intents,
  intentFor,
  leaves,
  neighbor,
  shown,
  type Target,
} from "./Rows.ts";

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

export const arrivals = Atom.make((get) => {
  get.addFinalizer(
    awaitArrivals((id, signal) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const atom = conversation(id);
      if (!AsyncResult.isInitial(get.registry.get(atom))) resolve();
      else {
        const done = () => {
          cancel();
          resolve();
        };
        const cancel = get.registry.subscribe(atom, (result) => {
          if (!AsyncResult.isInitial(result)) done();
        });
        signal.addEventListener("abort", done, { once: true });
      }
      return promise;
    }),
  );
});

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
        const jobs = new Map(
          Option.match(snapshot, {
            onNone: () => [],
            onSome: ({ digest }) =>
              [...(digest?.queued ?? []), ...(digest?.running ?? [])].map(
                (job) => [job.conversation_id, job] as const,
              ),
          }),
        );
        get.registry.update(
          digestRuns,
          (runs) =>
            new Map(
              [...new Set([...runs.keys(), ...jobs.keys()])].flatMap((id) => {
                const next = Digest.reconciled(runs.get(id) ?? Digest.idle, jobs.get(id));
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

const turns = new Map<number, Deferred.Deferred<void>>();

export const inTurn =
  (id: number) =>
  <A, E, R>(write: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const ahead = turns.get(id);
      const turn = Deferred.makeUnsafe<void>();
      turns.set(id, turn);
      return (ahead === undefined ? write : Effect.andThen(Deferred.await(ahead), write)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Deferred.doneUnsafe(turn, Effect.void);
            if (turns.get(id) === turn) turns.delete(id);
          }),
        ),
      );
    });

export const intents = Atom.make<Intents>(new Map()).pipe(Atom.keepAlive);

const changed = <A>(map: ReadonlyMap<number, A>, id: number, value: A | undefined) => {
  const next = new Map(map);
  if (value === undefined) next.delete(id);
  else next.set(id, value);
  return next;
};

export const visibleRows = Atom.family((view: View) =>
  Atom.make((get) =>
    AsyncResult.getOrElse(
      AsyncResult.map(get(viewList(view)), ({ conversations }) =>
        shown(view, conversations, get(intents)),
      ),
      (): ReadonlyArray<Row> => [],
    ),
  ),
);

const debounce = Duration.millis(150);

export const searchQuery = Atom.make((get) => parseQuery(get(route).query, get(tagOrder)));

const searchRequest = Atom.make((get) => searchParams(get(searchQuery))).pipe(
  Atom.withEquality(Option.makeEquivalence(sameParams)),
);

export const searching = Atom.make((get) => Option.isSome(get(searchRequest)));

export const searchPattern = Atom.make((get) => termPattern(get(searchQuery).text)).pipe(
  Atom.withEquality((left: RegExp | null, right: RegExp | null) => left?.source === right?.source),
);

export const searchResult = Weir.runtime
  .atom((get) =>
    Option.match(get(searchRequest), {
      onNone: () => Effect.succeed(Option.none<ReadonlyArray<Result>>()),
      onSome: (query) =>
        Effect.gen(function* () {
          yield* Effect.sleep(debounce);
          const client = yield* Weir;
          const { conversations } = yield* client.search({ query });
          return Option.some(conversations);
        }),
    }),
  )
  .pipe(Atom.withReactivity(["list"]));

export const searchGroup = Atom.make(Option.none<View>());

export const leaveSearch = Atom.writable(
  () => undefined,
  (ctx, _: undefined) => {
    ctx.set(searchOpen, false);
    ctx.set(searchGroup, Option.none());
    ctx.set(route, { _tag: "Type", query: "" });
  },
);

export const found = Atom.make((get) => Option.flatten(AsyncResult.value(get(searchResult))));

export const pickedGroup = Atom.make((get) =>
  Option.flatMap(get(found), (results) => picked(results, get(tagOrder), get(searchGroup))),
);

export const searchRows = Atom.make((get) =>
  Option.match(get(found), {
    onNone: (): ReadonlyArray<Result> => [],
    onSome: (results) => narrowed(results, get(pickedGroup)),
  }),
);

export const listedRows = Atom.make(
  (get): ReadonlyArray<Row> =>
    get(searching) ? get(searchRows) : get(visibleRows(get(route).view)),
);

const listing = Atom.make((get) => ({
  ids: get(listedRows)
    .map(({ id }) => id)
    .join(),
  loaded: get(searching)
    ? Option.isSome(get(found))
    : !AsyncResult.isInitial(get(viewList(get(route).view))),
}));

export const listMotion = Atom.make((get) => {
  let painted = false;
  let last: { readonly ids: string } | undefined;
  get.subscribe(
    listing,
    (next) => {
      if (last !== undefined && next.ids !== last.ids) capture(painted);
      painted ||= next.loaded;
      last = next;
    },
    { immediate: true },
  );
});

let exiting = false;

export const dismiss = Weir.runtime
  .fn<{ readonly act: Act; readonly target: Target }>()(
    ({ act, target }, get) =>
      Effect.gen(function* () {
        const client = yield* Weir;
        if (exiting) return;
        const exit = exits(get.registry.get(route).view, act, get.registry.get(searching))
          ? leave(String(target.id))
          : null;
        if (exit !== null) {
          exiting = true;
          yield* Effect.promise(() => exit).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                exiting = false;
              }),
            ),
          );
        }
        const current = get.registry.get(route);
        const { view } = current;
        const open = Option.contains(current.conversation, target.id);
        if (open && leaves(view, act)) {
          get.registry.set(route, {
            _tag: "Replace",
            to: {
              ...current,
              conversation: Option.map(neighbor(get.registry.get(listedRows), target.id), (next) =>
                ConversationId.make(next.id),
              ),
            },
          });
        }
        const before = get.registry.get(intents).get(target.id);
        const intent = intentFor(act, target);
        get.registry.update(intents, (map) => changed(map, target.id, intent));
        const params = { id: target.id };
        const request =
          act === "Done"
            ? client.done({ params, payload: { seq: target.last_seq } })
            : act === "Mute"
              ? client.mute({ params })
              : client.restore({ params });
        yield* inTurn(target.id)(request).pipe(
          Effect.onError(() =>
            Effect.sync(() =>
              get.registry.update(intents, (map) =>
                map.get(target.id) === intent ? changed(map, target.id, before) : map,
              ),
            ),
          ),
        );
        yield* Reactivity.invalidate(["counts", "list"]);
        yield* Reactivity.invalidate({ conversation: [target.id] });
        yield* Effect.ignore(
          Effect.all([
            get.result(viewList(view), { suspendOnWaiting: true }),
            ...(Option.contains(get.registry.get(route).conversation, target.id)
              ? [
                  get.result(conversation(ConversationId.make(target.id)), {
                    suspendOnWaiting: true,
                  }),
                ]
              : []),
          ]),
        );
        get.registry.update(intents, (map) =>
          map.get(target.id) === intent ? changed(map, target.id, undefined) : map,
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
