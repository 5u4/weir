import type { Face } from "@weir/contract/Source";
import * as Read from "@weir/store/Read";
import type { FaceHash, FaceOutcome, FaceRow } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import type { ScheduledSource } from "@weir/sync/Scheduler";
import { errorMessage, type FaceSource, hasFaces, lookupFaces } from "@weir/sync/Sync";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";
import type { Event } from "./Api.ts";

const foundFor = Duration.days(30);
const missingFor = Duration.days(1);
const redirectMaxAge = Duration.hours(1);
const unsupportedMaxAge = Duration.days(1);
const pendingRetryAfter = Duration.seconds(5);
const backoffBase = Duration.minutes(1);
const backoffCap = Duration.hours(1);
const workersPerSource = 2;
const batchMax = 16;
const callTimeout = Duration.seconds(30);

export interface FaceKey {
  readonly source: string;
  readonly address: string;
}

type Cached =
  | { readonly _tag: "Unknown" }
  | { readonly _tag: "Found"; readonly hash: FaceHash; readonly freshFor: Duration.Duration }
  | { readonly _tag: "Missing"; readonly freshFor: Duration.Duration };

export type Demand =
  | { readonly _tag: "Pending"; readonly retryAfter: Duration.Duration }
  | { readonly _tag: "Unsupported" };

type Answer =
  | { readonly _tag: "Found"; readonly hash: FaceHash; readonly maxAge: Duration.Duration }
  | { readonly _tag: "Missing"; readonly maxAge: Duration.Duration }
  | Demand;

export interface FaceResolver {
  readonly supports: (source: string) => boolean;
  readonly want: (key: FaceKey) => Effect.Effect<Demand>;
}

const pending: Demand = { _tag: "Pending", retryAfter: pendingRetryAfter };

const remaining = (ttl: Duration.Duration, fetchedAt: DateTime.Utc, now: number) =>
  Duration.millis(Math.max(0, DateTime.toEpochMillis(fetchedAt) + Duration.toMillis(ttl) - now));

const classify = (row: Option.Option<FaceRow>, verified: boolean, now: number): Cached =>
  Option.match(row, {
    onNone: () => ({ _tag: "Unknown" }),
    onSome: (face) => {
      if (face.hash === null) {
        return { _tag: "Missing", freshFor: remaining(missingFor, face.fetchedAt, now) };
      }
      const freshFor = remaining(foundFor, face.fetchedAt, now);
      return face.kind === "logo" && !verified
        ? { _tag: "Missing", freshFor: Duration.min(freshFor, redirectMaxAge) }
        : { _tag: "Found", hash: face.hash, freshFor };
    },
  });

export const lookup = Effect.fnUntraced(function* (
  resolver: Option.Option<FaceResolver>,
  key: FaceKey,
  verified: boolean,
): Effect.fn.Return<Answer, never, SqlClient.SqlClient> {
  if (Option.isSome(resolver) && !resolver.value.supports(key.source)) {
    return { _tag: "Unsupported" };
  }
  const cached = classify(
    yield* Read.face(key.source, key.address).pipe(Effect.orDie),
    verified,
    yield* Clock.currentTimeMillis,
  );
  if (cached._tag === "Found" && Duration.isGreaterThan(cached.freshFor, Duration.zero)) {
    return {
      _tag: "Found",
      hash: cached.hash,
      maxAge: Duration.min(cached.freshFor, redirectMaxAge),
    };
  }
  if (cached._tag === "Missing" && Duration.isGreaterThan(cached.freshFor, Duration.zero)) {
    return { _tag: "Missing", maxAge: cached.freshFor };
  }
  const demand = Option.isSome(resolver) ? yield* resolver.value.want(key) : pending;
  switch (cached._tag) {
    case "Found":
      return { _tag: "Found", hash: cached.hash, maxAge: Duration.zero };
    case "Missing":
      return { _tag: "Missing", maxAge: Duration.zero };
    case "Unknown":
      return demand;
  }
});

const seconds = (duration: Duration.Duration) => Math.ceil(Duration.toSeconds(duration));

export const respond = (answer: Answer): HttpServerResponse.HttpServerResponse => {
  switch (answer._tag) {
    case "Found":
      return HttpServerResponse.redirect(`/faces/${answer.hash}`, {
        status: 302,
        headers: {
          "cache-control":
            seconds(answer.maxAge) === 0
              ? "private, no-cache"
              : `private, max-age=${seconds(answer.maxAge)}`,
        },
      });
    case "Missing":
      return HttpServerResponse.empty({
        status: 404,
        headers: {
          "cache-control":
            seconds(answer.maxAge) === 0
              ? "no-store"
              : `private, max-age=${seconds(answer.maxAge)}`,
        },
      });
    case "Pending":
      return HttpServerResponse.empty({
        status: 503,
        headers: {
          "cache-control": "no-store",
          "retry-after": String(Math.max(1, seconds(answer.retryAfter))),
        },
      });
    case "Unsupported":
      return HttpServerResponse.empty({
        status: 404,
        headers: { "cache-control": `private, max-age=${seconds(unsupportedMaxAge)}` },
      });
  }
};

export const image = Effect.fnUntraced(function* (
  hash: FaceHash,
): Effect.fn.Return<HttpServerResponse.HttpServerResponse, never, SqlClient.SqlClient> {
  const blob = yield* Read.faceBlob(hash).pipe(Effect.orDie);
  return Option.match(blob, {
    onNone: () =>
      HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } }),
    onSome: ({ mime, bytes }) =>
      HttpServerResponse.uint8Array(bytes, {
        contentType: mime,
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "content-security-policy": "sandbox",
          "x-content-type-options": "nosniff",
        },
      }),
  });
});

type Entry =
  | { readonly _tag: "Queued"; readonly failures: number }
  | { readonly _tag: "Running"; readonly failures: number }
  | {
      readonly _tag: "Backoff";
      readonly failures: number;
      readonly until: number;
      readonly retryScheduled: boolean;
    };

interface Lane {
  readonly id: string;
  readonly source: FaceSource;
  readonly queue: Queue.Queue<string>;
  readonly entries: Map<string, Entry>;
}

const backoffFor = (failures: number) =>
  Duration.min(Duration.times(backoffBase, 2 ** (failures - 1)), backoffCap);

const noAnswer: Face = { status: "failed", error: "no answer" };

export const make = Effect.fnUntraced(function* (
  sources: ReadonlyArray<ScheduledSource>,
  publish: (event: Extract<Event, { type: "faces" }>) => Effect.Effect<void>,
): Effect.fn.Return<FaceResolver, never, Scope.Scope | SqlClient.SqlClient> {
  const scope = yield* Effect.scope;
  const lanes = new Map<string, Lane>();
  for (const { id, source } of sources) {
    if (!hasFaces(source)) continue;
    lanes.set(id, { id, source, queue: yield* Queue.unbounded<string>(), entries: new Map() });
  }

  const enqueue = (lane: Lane, address: string, failures: number) =>
    Effect.suspend(() => {
      lane.entries.set(address, { _tag: "Queued", failures });
      return Queue.offer(lane.queue, address);
    });

  const retryAt = (lane: Lane, address: string, wait: Duration.Duration) =>
    Effect.sleep(wait).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const entry = lane.entries.get(address);
          return entry?._tag === "Backoff" ? enqueue(lane, address, entry.failures) : Effect.void;
        }),
      ),
      Effect.forkIn(scope),
    );

  const settle = Effect.fnUntraced(function* (lane: Lane, batch: ReadonlyArray<string>) {
    const reply = yield* lookupFaces(lane.id, lane.source, batch).pipe(
      Effect.timeout(callTimeout),
      Effect.mapError(errorMessage),
      Effect.result,
    );
    const faces = batch.map((address): readonly [string, Face] => [
      address,
      Result.isSuccess(reply)
        ? ((Object.hasOwn(reply.success, address) ? reply.success[address] : undefined) ?? noAnswer)
        : { status: "failed", error: reply.failure },
    ]);
    const outcomes = faces.flatMap(
      ([address, face]): Array<FaceOutcome> =>
        face.status === "failed" ? [] : [{ address, ...face }],
    );
    const written = yield* Write.putFaces(lane.id, outcomes, yield* DateTime.now).pipe(
      Effect.tapError((error) => Effect.logError("storing faces failed", error)),
      Effect.result,
    );
    const now = yield* Clock.currentTimeMillis;
    for (const [address, face] of faces) {
      const failures = (lane.entries.get(address)?.failures ?? 0) + 1;
      if (face.status !== "failed" && Result.isSuccess(written)) {
        lane.entries.delete(address);
      } else {
        const wait = backoffFor(failures);
        const retryScheduled = Duration.isLessThan(wait, backoffCap);
        lane.entries.set(address, {
          _tag: "Backoff",
          failures,
          until: now + Duration.toMillis(wait),
          retryScheduled,
        });
        if (retryScheduled) yield* retryAt(lane, address, wait);
      }
    }
    if (Result.isSuccess(written) && written.success.length > 0) {
      yield* publish({ type: "faces", source: lane.id, addresses: written.success });
    }
  });

  for (const lane of lanes.values()) {
    const worker = Queue.takeBetween(lane.queue, 1, batchMax).pipe(
      Effect.tap((batch) =>
        Effect.sync(() => {
          for (const address of batch) {
            lane.entries.set(address, {
              _tag: "Running",
              failures: lane.entries.get(address)?.failures ?? 0,
            });
          }
        }),
      ),
      Effect.flatMap((batch) => settle(lane, batch)),
      Effect.forever,
    );
    for (let index = 0; index < workersPerSource; index++) {
      yield* Effect.forkIn(worker, scope);
    }
  }

  return {
    supports: (source) => lanes.has(source),
    want: ({ source, address }) =>
      Effect.gen(function* () {
        const lane = lanes.get(source);
        if (lane === undefined) return { _tag: "Unsupported" } satisfies Demand;
        const now = yield* Clock.currentTimeMillis;
        const entry = lane.entries.get(address);
        if (entry === undefined || (entry._tag === "Backoff" && entry.until <= now)) {
          yield* enqueue(lane, address, entry?.failures ?? 0);
          return pending;
        }
        if (entry._tag !== "Backoff") return pending;
        const wait = Duration.millis(entry.until - now);
        if (!entry.retryScheduled) {
          lane.entries.set(address, { ...entry, retryScheduled: true });
          yield* retryAt(lane, address, wait);
        }
        return { _tag: "Pending", retryAfter: wait } satisfies Demand;
      }),
  };
});
