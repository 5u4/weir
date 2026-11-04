import { describe, expect, it } from "@effect/vitest";
import type { Faces, Source } from "@weir/contract/Source";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { type Event, facePath } from "../src/Api.ts";
import * as Http from "../src/Http.ts";
import {
  apiClient,
  eventually,
  fakePlugin,
  fakeSource,
  makeHome,
  openEvents,
  sourceConfig,
} from "./harness.ts";

type FacesFn = NonNullable<Source["faces"]>;

const svg = (label: string) =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>`);

const start = (faces: FacesFn) =>
  Effect.gen(function* () {
    const { home, port, writeConfig } = makeHome("");
    writeConfig(sourceConfig("1h"));
    const daemonScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(daemonScope, Exit.void));
    yield* Layer.build(Http.layer(home, { fake: fakePlugin(fakeSource([], faces)) })).pipe(
      Scope.provide(daemonScope),
    );
    const client = yield* apiClient(port);
    const get = (path: string, headers: Record<string, string> = {}) =>
      Effect.promise(async () => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          redirect: "manual",
          headers,
        });
        return {
          status: response.status,
          header: (name: string) => response.headers.get(name),
          bytes: new Uint8Array(await response.arrayBuffer()),
        };
      });
    const face = (address: string, source = "mail") =>
      get(`/faces?${new URLSearchParams({ source, address })}`);
    return { port, client, get, face, writeConfig };
  });

const reply = (addresses: ReadonlyArray<string>, face: Faces[string]): Faces =>
  Object.fromEntries(addresses.map((address) => [address, face]));

const portrait = (bytes: Uint8Array) =>
  ({ status: "found", kind: "portrait", mime: "image/svg+xml", bytes }) as const;

const isFaces = (event: Event): event is Extract<Event, { type: "faces" }> =>
  event.type === "faces";

const steppedClock = (iso: string) =>
  Effect.gen(function* () {
    const live = yield* Clock.Clock;
    let millis = DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
    const reached = (target: number): Effect.Effect<void> =>
      Effect.suspend(() =>
        millis >= target
          ? Effect.void
          : live.sleep(Duration.millis(5)).pipe(Effect.andThen(reached(target))),
      );
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.sync(() => millis),
      currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(millis) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: live.monotonicTimeNanos,
      sleep: (duration) =>
        Effect.suspend(() =>
          Effect.raceFirst(live.sleep(duration), reached(millis + Duration.toMillis(duration))),
        ),
    };
    return {
      clock,
      advance: (duration: Duration.Duration) =>
        Effect.sync(() => {
          millis += Duration.toMillis(duration);
        }),
    };
  });

describe("faces", () => {
  it.live(
    "an unknown face answers 503, then after the faces event redirects to an immutable sandboxed image",
    () =>
      Effect.gen(function* () {
        const image = svg("ada");
        const { port, face, get } = yield* start(async (addresses) =>
          reply(addresses, portrait(image)),
        );
        const events = yield* openEvents(port);

        const first = yield* face("ada@example.com");
        expect(first.status).toBe(503);
        expect(first.header("cache-control")).toBe("no-store");
        expect(first.header("retry-after")).toBe("5");

        expect(yield* events.until(isFaces)).toEqual({
          type: "faces",
          source: "mail",
          addresses: ["ada@example.com"],
        });

        const redirect = yield* get(facePath("mail", " Ada@Example.com", false) ?? "");
        expect(redirect.status).toBe(302);
        expect(redirect.header("cache-control")).toBe("private, max-age=3600");
        const location = redirect.header("location") ?? "";
        expect(location).toMatch(/^\/faces\/[0-9a-f]{64}$/);

        const blob = yield* get(location);
        expect(blob.status).toBe(200);
        expect(blob.header("content-type")).toBe("image/svg+xml");
        expect(blob.header("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(blob.header("content-security-policy")).toBe("sandbox");
        expect(blob.header("x-content-type-options")).toBe("nosniff");
        expect(blob.bytes).toEqual(image);

        const unknown = yield* get(`/faces/${"0".repeat(64)}`);
        expect(unknown.status).toBe(404);
        expect(unknown.header("cache-control")).toBe("no-store");
      }).pipe(Effect.scoped),
  );

  it.live("a missing face is a cacheable 404 that the plugin is not asked for again", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { face } = yield* start(async (addresses) => {
        calls += 1;
        return reply(addresses, { status: "missing" });
      });

      expect((yield* face("bo@example.com")).status).toBe(503);
      const missing = yield* eventually(face("bo@example.com"), ({ status }) => status === 404);
      expect(missing.status).toBe(404);
      const maxAge = Number(
        /^private, max-age=(\d+)$/.exec(missing.header("cache-control") ?? "")?.[1],
      );
      expect(maxAge).toBeGreaterThan(0);
      expect(maxAge).toBeLessThanOrEqual(86400);

      expect((yield* face("bo@example.com")).status).toBe(404);
      expect(calls).toBe(1);

      const unsupported = yield* face("bo@example.com", "nope");
      expect(unsupported.status).toBe(404);
      expect(unsupported.header("cache-control")).toBe("private, max-age=86400");
    }).pipe(Effect.scoped),
  );

  it.live("a brand logo is served only to a verified sender, a portrait to anyone", () =>
    Effect.gen(function* () {
      const { get } = yield* start(async (addresses) =>
        Object.fromEntries(
          addresses.map((address) => [
            address,
            {
              status: "found",
              kind: address.endsWith("@northwind.example") ? "logo" : "portrait",
              mime: "image/svg+xml",
              bytes: svg(address),
            } as const,
          ]),
        ),
      );
      const at = (address: string, verified: boolean) =>
        get(facePath("mail", address, verified) ?? "");

      expect((yield* at("rachel@northwind.example", true)).status).toBe(503);
      expect((yield* at("hal@example.com", false)).status).toBe(503);
      yield* eventually(at("rachel@northwind.example", true), ({ status }) => status === 302);
      yield* eventually(at("hal@example.com", false), ({ status }) => status === 302);

      expect((yield* at("rachel@northwind.example", false)).status).toBe(404);
      expect((yield* at("hal@example.com", true)).status).toBe(302);
    }).pipe(Effect.scoped),
  );

  it.live("a cross-site request is refused before the cache is read or a lookup queued", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { face, get } = yield* start(async (addresses) => {
        calls += 1;
        return reply(addresses, portrait(svg("gil")));
      });
      const path = facePath("mail", "gil@example.com", false) ?? "";
      const from = (site: string) => ({ "sec-fetch-site": site });

      for (const site of ["cross-site", "same-site"]) {
        expect((yield* get(path, from(site))).status).toBe(403);
      }
      yield* Effect.sleep(Duration.millis(100));
      expect(calls).toBe(0);

      expect((yield* get(path, from("none"))).status).toBe(503);
      const found = yield* eventually(face("gil@example.com"), ({ status }) => status === 302);
      const location = found.header("location") ?? "";
      expect((yield* get(path, from("cross-site"))).status).toBe(403);
      expect((yield* get(location, from("cross-site"))).status).toBe(403);
      expect((yield* get(path, from("same-origin"))).status).toBe(302);
      expect((yield* get(location, from("same-origin"))).status).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.live("a cached face is not served once its source no longer offers faces", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { client, face, writeConfig } = yield* start(async (addresses) => {
        calls += 1;
        return reply(addresses, portrait(svg("fay")));
      });

      expect((yield* face("fay@example.com")).status).toBe(503);
      yield* eventually(face("fay@example.com"), ({ status }) => status === 302);

      writeConfig(sourceConfig("1h").replace('id = "mail"', 'id = "work"'));
      yield* client.reload();
      const gone = yield* face("fay@example.com");
      expect(gone.status).toBe(404);
      expect(gone.header("cache-control")).toBe("private, max-age=86400");
      expect(calls).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live("a failed lookup retries on its own and publishes the face once it is found", () =>
    Effect.gen(function* () {
      const { clock, advance } = yield* steppedClock("2026-11-01T00:00:00Z");
      yield* Effect.gen(function* () {
        let calls = 0;
        const { port, face } = yield* start(async (addresses) => {
          calls += 1;
          return calls === 1
            ? reply(addresses, { status: "failed", error: "offline" })
            : reply(addresses, portrait(svg("cy")));
        });
        const events = yield* openEvents(port);

        expect((yield* face("cy@example.com")).status).toBe(503);
        yield* eventually(
          Effect.sync(() => calls),
          (count) => count === 1,
        );
        yield* Effect.sleep(Duration.millis(200)).pipe(Effect.provideService(Clock.Clock, clock));
        yield* advance(Duration.seconds(61));
        expect(yield* events.until(isFaces)).toEqual({
          type: "faces",
          source: "mail",
          addresses: ["cy@example.com"],
        });
        expect(calls).toBe(2);
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped),
  );

  it.live("automatic retries stop once backoff reaches its cap, until asked again", () =>
    Effect.gen(function* () {
      const { clock, advance } = yield* steppedClock("2026-11-01T00:00:00Z");
      yield* Effect.gen(function* () {
        let calls = 0;
        const { face } = yield* start(async (addresses) => {
          calls += 1;
          return reply(addresses, { status: "failed", error: "rate limited" });
        });

        expect((yield* face("cy@example.com")).status).toBe(503);
        for (const [index, minutes] of [1, 2, 4, 8, 16, 32].entries()) {
          yield* eventually(
            Effect.sync(() => calls),
            (count) => count === index + 1,
          );
          yield* Effect.sleep(Duration.millis(200));
          yield* advance(Duration.minutes(minutes).pipe(Duration.sum(Duration.seconds(1))));
        }
        yield* eventually(
          Effect.sync(() => calls),
          (count) => count === 7,
        );

        yield* advance(Duration.hours(2));
        yield* Effect.sleep(Duration.millis(300));
        expect(calls).toBe(7);

        expect((yield* face("cy@example.com")).status).toBe(503);
        yield* eventually(
          Effect.sync(() => calls),
          (count) => count === 8,
        );
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }).pipe(Effect.scoped),
  );

  it.live("concurrent requests for one face, in any letter case, make one plugin call", () =>
    Effect.gen(function* () {
      const asked: Array<ReadonlyArray<string>> = [];
      const release = Promise.withResolvers<void>();
      const { face } = yield* start(async (addresses) => {
        asked.push(addresses);
        await release.promise;
        return reply(addresses, portrait(svg("dee")));
      });

      const spellings = ["dee@example.com", "Dee@Example.com", " DEE@example.com "];
      const responses = yield* Effect.all(
        Array.from({ length: 10 }, (_, index) => face(spellings[index % spellings.length] ?? "")),
        { concurrency: "unbounded" },
      );
      expect(responses.map(({ status }) => status)).toEqual(Array(10).fill(503));
      yield* eventually(
        Effect.sync(() => asked.length),
        (count) => count === 1,
      );
      release.resolve();
      expect(
        (yield* eventually(face("dee@example.com"), ({ status }) => status === 302)).status,
      ).toBe(302);
      expect(asked).toEqual([["dee@example.com"]]);
    }).pipe(Effect.scoped),
  );

  it.live("one source runs at most two plugin calls at once, each with at most 16 addresses", () =>
    Effect.gen(function* () {
      let running = 0;
      let peak = 0;
      const batches: Array<number> = [];
      const release = Promise.withResolvers<void>();
      const { face } = yield* start(async (addresses) => {
        running += 1;
        peak = Math.max(peak, running);
        batches.push(addresses.length);
        await release.promise;
        running -= 1;
        return reply(addresses, { status: "missing" });
      });

      const addresses = Array.from({ length: 40 }, (_, index) => `p${index}@example.com`);
      yield* Effect.all(
        addresses.map((address) => face(address)),
        { concurrency: "unbounded" },
      );
      yield* eventually(
        Effect.sync(() => running),
        (count) => count === 2,
      );
      yield* Effect.sleep(Duration.millis(100));
      expect(running).toBe(2);

      release.resolve();
      yield* eventually(
        Effect.sync(() => batches.reduce((sum, size) => sum + size, 0)),
        (total) => total === addresses.length,
      );
      for (const address of addresses) {
        expect((yield* eventually(face(address), ({ status }) => status === 404)).status).toBe(404);
      }
      expect(peak).toBe(2);
      expect(Math.max(...batches)).toBeLessThanOrEqual(16);
    }).pipe(Effect.scoped),
  );

  it.live("a reload aborts the in-flight lookup and stores nothing from it", () =>
    Effect.gen(function* () {
      const signals: Array<AbortSignal> = [];
      const release = Promise.withResolvers<void>();
      const { client, face } = yield* start(async (addresses, signal) => {
        signals.push(signal);
        if (signals.length === 1) await release.promise;
        else await Promise.withResolvers<never>().promise;
        return reply(addresses, portrait(svg("eve")));
      });

      expect((yield* face("eve@example.com")).status).toBe(503);
      yield* eventually(
        Effect.sync(() => signals.length),
        (count) => count === 1,
      );
      yield* client.reload();
      expect(signals[0]?.aborted).toBe(true);

      release.resolve();
      yield* Effect.sleep(Duration.millis(100));
      const after = yield* face("eve@example.com");
      expect(after.status).toBe(503);
      expect(after.header("retry-after")).toBe("5");
    }).pipe(Effect.scoped),
  );
});
