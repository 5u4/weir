import react from "@vitejs/plugin-react";
import { Api, defaultPort } from "@weir/daemon/Api";
import { isLoopbackRequest } from "@weir/daemon/Loopback";
import * as HttpApi from "effect/http-api/HttpApi";
import { type Connect, defineConfig, type Plugin } from "vite";

const daemon = `http://127.0.0.1:${process.env.WEIR_PORT ?? defaultPort}`;

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

export default defineConfig({
  plugins: [loopback, react()],
  publicDir: false,
  server: {
    proxy: {
      [`^/(${[...apiRoots].join("|")})(/|\\?|$)`]: {
        target: daemon,
        changeOrigin: true,
        headers: { origin: daemon },
      },
    },
  },
});
