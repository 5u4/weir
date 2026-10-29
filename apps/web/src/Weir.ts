import { Api } from "@weir/daemon/Api";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Atom from "effect/reactivity/Atom";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";

export class Weir extends AtomHttpApi.Service<Weir>()("Weir", {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl: location.origin,
}) {}

export const status = Weir.query("weir", "status", {});

export const reload = Weir.mutation("weir", "reload");

export const statusOpen = Atom.writable(
  (get) => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") get.setSelf(false);
    };
    addEventListener("keydown", closeOnEscape);
    get.addFinalizer(() => removeEventListener("keydown", closeOnEscape));
    return false;
  },
  (ctx, open: boolean) => ctx.setSelf(open),
);
