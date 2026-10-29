import { Api } from "@weir/daemon/Api";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as AtomHttpApi from "effect/reactivity/AtomHttpApi";

export class Weir extends AtomHttpApi.Service<Weir>()("Weir", {
  api: Api,
  httpClient: FetchHttpClient.layer,
  baseUrl: location.origin,
}) {}

export const status = Weir.query("weir", "status", {});
