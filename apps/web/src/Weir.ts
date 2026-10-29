import { Api, View as ApiView, ClearableView, type Row } from "@weir/daemon/Api";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import { now } from "./Health.ts";
import { statusOpen, type View } from "./Route.ts";
import { type Intents, intentFor } from "./Rows.ts";

export class Weir extends AtomHttpApi.Service<Weir>()("Weir", {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl: location.origin,
}) {}

const statusSnapshot = Weir.query("weir", "status", {});

// TODO: when `Api` includes `EventsGroup`, invalidate on `sync` events instead of polling.
export const status = Atom.transform(
  statusSnapshot,
  (get) => {
    // Atom subscribers fire when an unbuilt atom first builds, so build `now` before subscribing.
    get.once(now);
    get.subscribe(now, () => get.refresh(statusSnapshot));
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

const polled = <A>(atom: Atom.Atom<A>) =>
  Atom.transform(
    atom,
    (get) => {
      get.once(now);
      get.subscribe(now, () => get.refresh(atom));
      get.subscribe(atom, (value) => get.setSelf(value));
      return get.once(atom);
    },
    { initialValueTarget: atom },
  );

export const searchOpen = Atom.make(false);

export const counts = polled(Weir.query("view", "counts", { reactivityKeys: ["counts"] }));

const toApiView = Schema.decodeSync(ApiView);
const toClearableView = Schema.decodeSync(ClearableView);

export const viewList = Atom.family((view: View) =>
  polled(
    Weir.query("view", "conversations", {
      query: { view: toApiView(view) },
      reactivityKeys: ["list"],
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
