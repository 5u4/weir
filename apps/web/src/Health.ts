import type { Status } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Atom from "effect/reactivity/Atom";

export type SourceState =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "NotSynced" }
  | { readonly _tag: "Synced"; readonly at: DateTime.Utc }
  | { readonly _tag: "Failed"; readonly error: string; readonly lastGood: DateTime.Utc | null };

export type SourceHealth = {
  readonly id: string;
  readonly plugin: string;
  readonly state: SourceState;
  readonly streams: number;
  readonly backfilling: boolean;
};

export type Verdict =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "SourceDown"; readonly source: string }
  | { readonly _tag: "Running"; readonly lastSync: DateTime.Utc | null };

export type Health = {
  readonly sources: ReadonlyArray<SourceHealth>;
  readonly stopped: boolean;
  readonly verdict: Verdict;
  readonly alert: boolean;
};

const latest = (times: ReadonlyArray<string | null>) =>
  times.reduce<DateTime.Utc | null>((max, time) => {
    if (time === null) return max;
    const at = DateTime.makeUnsafe(time);
    return max === null || DateTime.isGreaterThan(at, max) ? at : max;
  }, null);

const sourceState = (source: Status["sources"][number]): SourceState => {
  const lastSync = latest(source.streams.map(({ last_sync_at }) => last_sync_at));
  const error =
    source.listing === "failed"
      ? (source.error ?? "listing failed")
      : source.streams.find(({ last_error }) => last_error !== null)?.last_error;
  if (error !== undefined && error !== null) {
    return { _tag: "Failed", error, lastGood: lastSync };
  }
  if (source.listing === "pending") return { _tag: "Starting" };
  return lastSync === null ? { _tag: "NotSynced" } : { _tag: "Synced", at: lastSync };
};

export const health = (status: Status): Health => {
  const sources = status.sources.map(
    (source): SourceHealth => ({
      id: source.id,
      plugin: source.plugin,
      state: sourceState(source),
      streams: source.streams.length,
      backfilling: source.streams.some(({ backfill }) => backfill === "running"),
    }),
  );
  const stopped = status.config.error !== null;
  const down = sources.find(({ state }) => state._tag === "Failed");
  const verdict: Verdict = stopped
    ? { _tag: "Stopped" }
    : down !== undefined
      ? { _tag: "SourceDown", source: down.id }
      : {
          _tag: "Running",
          lastSync: latest(
            status.sources.flatMap(({ streams }) =>
              streams.map(({ last_sync_at }) => last_sync_at),
            ),
          ),
        };
  return { sources, stopped, verdict, alert: verdict._tag !== "Running" };
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

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
