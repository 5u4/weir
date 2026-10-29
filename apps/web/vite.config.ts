import react from "@vitejs/plugin-react";
import { Api, defaultPort } from "@weir/daemon/Api";
import * as HttpApi from "effect/http-api/HttpApi";
import { defineConfig } from "vite";

const daemon = `http://127.0.0.1:${process.env.WEIR_PORT ?? defaultPort}`;

const apiRoots = new Set<string>();
HttpApi.reflect(Api, {
  onGroup: () => {},
  onEndpoint: ({ endpoint }) => {
    apiRoots.add(endpoint.path.split("/")[1] ?? "");
  },
});

export default defineConfig({
  plugins: [react()],
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
