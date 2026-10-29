import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const defaultDist = join(import.meta.dirname, "../../web/dist");

const assetName = /^[\w-][\w.-]*$/;

const notBuilt = HttpServerResponse.text("weir web UI is not built: run `bun run build:web`\n", {
  status: 503,
});

const notFound = HttpServerResponse.empty({ status: 404 });

export const layer = (dist: string) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/",
      HttpServerResponse.file(join(dist, "index.html"), {
        headers: { "cache-control": "no-cache" },
      }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(notBuilt))),
    ),
    HttpRouter.add(
      "GET",
      "/assets/:name",
      Effect.flatMap(HttpRouter.params, ({ name }) =>
        name !== undefined && assetName.test(name)
          ? HttpServerResponse.file(join(dist, "assets", name), {
              headers: { "cache-control": "public, max-age=31536000, immutable" },
            }).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(notFound)))
          : Effect.succeed(notFound),
      ),
    ),
  );
