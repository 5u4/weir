import { Api } from "@weir/daemon/Api";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Atom from "effect/reactivity/Atom";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";
import { now } from "./Health.ts";
import { statusOpen } from "./Route.ts";

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

export const reload = Weir.mutation("weir", "reload");
