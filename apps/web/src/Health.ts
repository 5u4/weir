import type { Status } from "@weir/daemon/Api";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";

export type SourceState =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "NotSynced" }
  | { readonly _tag: "Synced"; readonly at: DateTime.Utc }
  | { readonly _tag: "Failed"; readonly error: string; readonly tried: DateTime.Utc | null };

export type StreamState = Exclude<SourceState, { readonly _tag: "Starting" }>;

export type StreamHealth = {
  readonly name: string;
  readonly state: StreamState;
  readonly items: number;
  readonly backfilling: boolean;
};

export type SourceHealth = {
  readonly id: string;
  readonly plugin: string;
  readonly state: SourceState;
  readonly streams: ReadonlyArray<StreamHealth>;
};

export type Health = {
  readonly sources: ReadonlyArray<SourceHealth>;
  readonly stopped: boolean;
};

type ConfigProblem = NonNullable<Status["config"]["error"]>;

export type FailedSource = { readonly id: string; readonly since: DateTime.Utc | null };

export type Alert =
  | { readonly _tag: "ConfigStopped"; readonly error: ConfigProblem }
  | { readonly _tag: "SourcesFailed"; readonly sources: Arr.NonEmptyReadonlyArray<FailedSource> };

const extreme =
  (later: boolean) =>
  (times: ReadonlyArray<string | null>): DateTime.Utc | null =>
    times.reduce<DateTime.Utc | null>((best, time) => {
      if (time === null) return best;
      const at = DateTime.makeUnsafe(time);
      return best === null || DateTime.isGreaterThan(at, best) === later ? at : best;
    }, null);

const latest = extreme(true);

const earliest = extreme(false);

const sourceState = (source: Status["sources"][number]): SourceState => {
  const lastSync = latest(source.streams.map(({ last_sync_at }) => last_sync_at));
  const error =
    source.listing === "failed"
      ? (source.error ?? "listing failed")
      : source.streams.find(({ last_error }) => last_error !== null)?.last_error;
  if (error !== undefined && error !== null) {
    return { _tag: "Failed", error, tried: lastSync };
  }
  if (source.listing === "pending") return { _tag: "Starting" };
  return lastSync === null ? { _tag: "NotSynced" } : { _tag: "Synced", at: lastSync };
};

const streamHealth = (stream: Status["sources"][number]["streams"][number]): StreamHealth => {
  const at = latest([stream.last_sync_at]);
  return {
    name: stream.name,
    state:
      stream.last_error !== null
        ? { _tag: "Failed", error: stream.last_error, tried: at }
        : at === null
          ? { _tag: "NotSynced" }
          : { _tag: "Synced", at },
    items: stream.items,
    backfilling: stream.backfill === "running",
  };
};

export const health = (status: Status): Health => ({
  sources: status.sources.map(
    (source): SourceHealth => ({
      id: source.id,
      plugin: source.plugin,
      state: sourceState(source),
      streams: source.streams.map(streamHealth),
    }),
  ),
  stopped: status.config.error !== null,
});

export const alertOf = (status: Status): Option.Option<Alert> => {
  if (status.config.error !== null) {
    return Option.some({ _tag: "ConfigStopped", error: status.config.error });
  }
  const failed = status.sources.flatMap((source): ReadonlyArray<FailedSource> => {
    const failing =
      source.listing === "failed"
        ? source.streams
        : source.streams.filter(({ last_error }) => last_error !== null);
    if (source.listing !== "failed" && failing.length === 0) return [];
    return [{ id: source.id, since: earliest(failing.map(({ last_ok_at }) => last_ok_at)) }];
  });
  return Arr.isReadonlyArrayNonEmpty(failed)
    ? Option.some({ _tag: "SourcesFailed", sources: failed })
    : Option.none();
};

export type ConfigState =
  | { readonly _tag: "Reloading" }
  | { readonly _tag: "Loaded"; readonly at: DateTime.Utc }
  | { readonly _tag: "Invalid"; readonly problem: ConfigProblem }
  | { readonly _tag: "RequestFailed"; readonly reason: string };

export const configState = (
  reload: AsyncResult.AsyncResult<void, unknown>,
  config: Status["config"],
): ConfigState => {
  if (AsyncResult.isWaiting(reload)) return { _tag: "Reloading" };
  if (AsyncResult.isFailure(reload)) {
    const error = Cause.squash(reload.cause);
    return {
      _tag: "RequestFailed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return config.error === null
    ? { _tag: "Loaded", at: DateTime.makeUnsafe(config.loaded_at) }
    : { _tag: "Invalid", problem: config.error };
};

export const now = Atom.make((get) => {
  const tick = setInterval(() => get.setSelf(DateTime.nowUnsafe()), 30_000);
  get.addFinalizer(() => clearInterval(tick));
  return DateTime.nowUnsafe();
});

export const ago = (at: DateTime.Utc, current: DateTime.Utc) => {
  const elapsed = Duration.toSeconds(DateTime.distance(at, current));
  if (elapsed < 60) return "just now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86400)}d ago`;
};

export const clockTime = (at: DateTime.Utc) =>
  DateTime.formatLocal(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const dayAndTime = (at: DateTime.Utc) =>
  DateTime.formatLocal(at, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

export const calendarDay = (at: DateTime.Utc) => {
  const local = DateTime.toDate(at);
  return Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()) / 86_400_000;
};

export const shortTime = (at: DateTime.Utc, current: DateTime.Utc) => {
  const elapsed = Duration.toSeconds(DateTime.distance(at, current));
  if (elapsed < 60) return "now";
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`;
  const days = calendarDay(current) - calendarDay(at);
  if (days === 0) return clockTime(at);
  if (days === 1) return "Yesterday";
  if (days < 7) return DateTime.formatLocal(at, { weekday: "short" });
  return DateTime.formatLocal(at, { month: "short", day: "numeric" });
};

export const dayLabel = (at: DateTime.Utc, current: DateTime.Utc) => {
  const days = calendarDay(current) - calendarDay(at);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return DateTime.formatLocal(at, { weekday: "short", month: "short", day: "numeric" });
};

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
