import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { Api, defaultPort } from "@weir/daemon/Api";
import * as ConfigFile from "@weir/daemon/ConfigFile";
import * as Home from "@weir/daemon/Home";
import { isLoopbackRequest } from "@weir/daemon/Loopback";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Connect, defineConfig, type Plugin, type UserConfig } from "vite";

const daemonPort = Effect.gen(function* () {
  const override = yield* Config.option(Config.Port("WEIR_PORT"));
  if (Option.isSome(override)) return override.value;
  const home = yield* Home.fromEnv;
  return yield* Effect.firstSuccessOf([
    Effect.tryPromise(() => Bun.file(home.daemon).text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Home.DaemonFile))),
      Effect.map(({ port }) => port),
    ),
    ConfigFile.read(home.config).pipe(Effect.flatMap(({ port }) => Effect.fromNullishOr(port))),
  ]).pipe(Effect.orElseSucceed(() => defaultPort));
});

const apiRoots = new Set<string>();
HttpApi.reflect(Api, {
  onGroup: () => {},
  onEndpoint: ({ endpoint }) => {
    apiRoots.add(endpoint.path.split("/")[1] ?? "");
  },
});

const loopbackOnly: Connect.NextHandleFunction = (req, res, next) => {
  if (isLoopbackRequest(req.headers.host, req.headers.origin, req.socket.localPort ?? 0)) {
    next();
    return;
  }
  res.statusCode = 403;
  res.end();
};

const loopback: Plugin = {
  name: "weir-loopback",
  configureServer: (server) => {
    server.middlewares.use(loopbackOnly);
  },
  configurePreviewServer: (server) => {
    server.middlewares.use(loopbackOnly);
  },
};

const proxy = async () => {
  const daemon = `http://127.0.0.1:${await Effect.runPromise(daemonPort)}`;
  return {
    [`^/(${[...apiRoots].join("|")})(/|\\?|$)`]: {
      target: daemon,
      changeOrigin: true,
      headers: { origin: daemon },
    },
  };
};

export default defineConfig(
  async ({ command }): Promise<UserConfig> => ({
    plugins: [loopback, tailwindcss({ optimize: false }), react()],
    publicDir: false,
    server: command === "serve" ? { proxy: await proxy() } : {},
  }),
);
