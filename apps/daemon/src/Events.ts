import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Sse from "effect/encoding/Sse";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Event } from "./Api.ts";

export const PingInterval = Context.Reference<Duration.Duration>(
  "@weir/daemon/Events/PingInterval",
  { defaultValue: () => Duration.seconds(5) },
);

export interface Events {
  readonly publish: (event: Event) => Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
  readonly respond: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope>;
}

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(Event));

const render = (event: Event) =>
  encodeEvent(event).pipe(
    Effect.orDie,
    Effect.map((data) =>
      Sse.encoder.write({ _tag: "Event", event: "message", id: undefined, data }),
    ),
  );

const ping = ": ping\n\n";

export const make = Effect.gen(function* () {
  const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Event>(), PubSub.shutdown);
  const interval = yield* PingInterval;
  const respond = Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(pubsub);
    const events = Stream.fromSubscription(subscription).pipe(Stream.mapEffect(render));
    const pings = Stream.tick(interval).pipe(
      Stream.drop(1),
      Stream.map(() => ping),
    );
    const body = Stream.fromEffect(render({ type: "ready" })).pipe(
      Stream.concat(Stream.merge(events, pings, { haltStrategy: "left" })),
      Stream.encodeText,
    );
    return HttpEffect.scopeTransferToStream(
      HttpServerResponse.stream(body, {
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
      }),
    );
  });
  return {
    publish: (event) => Effect.asVoid(PubSub.publish(pubsub, event)),
    shutdown: PubSub.shutdown(pubsub),
    respond,
  } satisfies Events;
});
