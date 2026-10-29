import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpApi from "effect/http-api/HttpApi";
import * as Layer from "effect/Layer";
import { Api } from "../src/Api.ts";
import * as Http from "../src/Http.ts";
import { fakePlugin, fakeSource, makeHome, rawRequest, sourceConfig } from "./harness.ts";

const builtDist = () => {
  const dist = mkdtempSync(join(tmpdir(), "weir-web-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>weir</title>");
  writeFileSync(join(dist, "assets", "a.js"), "export {};");
  writeFileSync(join(dist, "secret.txt"), "outside assets");
  return dist;
};

const serve = (dist: string) =>
  Effect.gen(function* () {
    const { home, port } = makeHome(sourceConfig("1h"));
    yield* Layer.build(Http.layer(home, { fake: fakePlugin(fakeSource([])) }, dist));
    const get = (path: string) =>
      Effect.promise(async () => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`);
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          body: await response.text(),
        };
      });
    return { home, port, get };
  });

describe("web UI", () => {
  it.live("serves index.html at / and hashed assets under /assets, nothing else", () =>
    Effect.gen(function* () {
      const { port, get } = yield* serve(builtDist());

      const index = yield* get("/");
      expect(index.status).toBe(200);
      expect(index.contentType).toMatch(/^text\/html/);
      expect(index.cacheControl).toBe("no-cache");
      expect(index.body).toBe("<!doctype html><title>weir</title>");

      const asset = yield* get("/assets/a.js");
      expect(asset.status).toBe(200);
      expect(asset.contentType).toMatch(/^text\/javascript/);
      expect(asset.cacheControl).toBe("public, max-age=31536000, immutable");

      for (const path of [
        "/assets/..%2fsecret.txt",
        "/assets/..%2fx",
        "/assets/../secret.txt",
        "/assets/.hidden",
        "/assets/missing.js",
        "/index.html",
        "/secret.txt",
        "/nope",
        "/c/1",
      ]) {
        const response = yield* rawRequest(port, {
          method: "GET",
          path,
          headers: { Host: `127.0.0.1:${port}` },
        });
        expect([path, response.status]).toEqual([path, 404]);
      }

      for (const path of ["/assets/..", "/assets/%2e%2e"]) {
        const response = yield* rawRequest(port, {
          method: "GET",
          path,
          headers: { Host: `127.0.0.1:${port}` },
        });
        expect([path, response.status, response.body]).toEqual([path, 200, index.body]);
      }

      const status = yield* get("/status");
      expect(status.status).toBe(200);
      expect(status.contentType).toMatch(/^application\/json/);
    }).pipe(Effect.scoped),
  );

  it.live("rejects a foreign Host on the UI routes too", () =>
    Effect.gen(function* () {
      const { port } = yield* serve(builtDist());
      for (const path of ["/", "/assets/a.js", "/status"]) {
        const response = yield* rawRequest(port, {
          method: "GET",
          path,
          headers: { Host: `evil.example:${port}` },
        });
        expect([path, response.status]).toEqual([path, 403]);
      }
    }).pipe(Effect.scoped),
  );

  it.live("without a build, / says how to build it and the API keeps serving", () =>
    Effect.gen(function* () {
      const { get } = yield* serve(mkdtempSync(join(tmpdir(), "weir-web-missing-")));

      const index = yield* get("/");
      expect(index.status).toBe(503);
      expect(index.contentType).toMatch(/^text\/plain/);
      expect(index.body).toContain("bun run build:web");

      expect((yield* get("/assets/a.js")).status).toBe(404);
      expect((yield* get("/status")).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it("no API endpoint lives at / or under /assets", () => {
    const paths: Array<string> = [];
    HttpApi.reflect(Api, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => {
        paths.push(endpoint.path);
      },
    });
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path === "/" || /^\/assets(\/|$)/.test(path))).toEqual([]);
  });
});
