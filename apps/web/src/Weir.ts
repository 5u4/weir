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
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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

export const live = Weir.runtime.atom((get) =>
  Stream.runForEach(events, (event) =>
    Effect.gen(function* () {
      const { view, conversation: open } = get.registry.get(route);
      const listed = AsyncResult.getOrElse(
        AsyncResult.map(get.registry.get(viewList(view)), ({ conversations }) =>
          conversations.map(({ id }) => id),
        ),
        () => [],
      );
      const refetch = refetches(event, listed, open);
      if (refetch.status) get.registry.refresh(statusSnapshot);
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
