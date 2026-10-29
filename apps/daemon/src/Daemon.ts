import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { Config } from "@weir/contract/Config";
import * as Digester from "@weir/digest/Digester";
import { gws } from "@weir/plugin-gws";
import * as Read from "@weir/store/Read";
import * as Write from "@weir/store/Write";
import * as Scheduler from "@weir/sync/Scheduler";
import { recomputeAllTags } from "@weir/sync/Tags";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { type ConfigInvalid, defaultPort } from "./Api.ts";
import * as ConfigFile from "./ConfigFile.ts";
import type { WeirHome } from "./Home.ts";

export const plugins: Scheduler.PluginRegistry = { gws };

export type Listing =
  | { readonly state: "pending" }
  | { readonly state: "ok" }
  | { readonly state: "failed"; readonly error: string };

export interface State {
  readonly config: Config;
  readonly loadedAt: DateTime.Utc;
  readonly configError: ConfigInvalid | null;
  readonly listings: ReadonlyMap<string, Listing>;
}

export class Daemon extends Context.Service<
  Daemon,
  {
    readonly home: WeirHome;
    readonly port: number;
    readonly state: Effect.Effect<State>;
    readonly reload: Effect.Effect<State, ConfigInvalid>;
    readonly digester: Effect.Effect<Option.Option<Digester.Digester>>;
  }
>()("@weir/daemon/Daemon") {}

const platform = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);

export const layer = (home: WeirHome, registry: Scheduler.PluginRegistry) =>
  Layer.effect(
    Daemon,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* ConfigFile.load(home.config, registry);
      const state = yield* Ref.make<State>({
        config: initial.config,
        loadedAt: yield* DateTime.now,
        configError: null,
        listings: new Map(),
      });
      const digester = yield* Ref.make(Option.none<Digester.Digester>());
      const scheduler = yield* FiberHandle.make<void, never>();
      const reloading = yield* Semaphore.make(1);

      const report = (sourceId: string, error: string | null) =>
        Ref.update(state, (current) => ({
          ...current,
          listings: new Map(current.listings).set(
            sourceId,
            error === null ? { state: "ok" } : { state: "failed", error },
          ),
        }));

      const generation = ({ config, sources, digest }: ConfigFile.Loaded) =>
        Effect.gen(function* () {
          const current = digest === null ? null : yield* Digester.make(digest, home.digestLogs);
          if (current !== null) {
            yield* Effect.acquireRelease(Ref.set(digester, Option.some(current)), () =>
              Ref.set(digester, Option.none()),
            );
            yield* Read.aiConversations().pipe(
              Effect.flatMap(current.auto),
              Effect.catch((error) => Effect.logError("startup digest check failed", error)),
            );
          }
          yield* Scheduler.run(sources, config.tag, report, current?.auto ?? (() => Effect.void));
          return yield* Effect.never;
        }).pipe(
          Effect.scoped,
          Effect.provide(platform),
          Effect.provideService(SqlClient.SqlClient, sql),
        );

      const start = Effect.fnUntraced(function* (loaded: ConfigFile.Loaded) {
        const { config, sources } = loaded;
        yield* sql.withTransaction(
          Write.reconcileTagState(config.tag.filter(({ ai }) => ai).map(({ name }) => name)).pipe(
            Effect.andThen(recomputeAllTags(config.tag)),
          ),
        );
        const loadedAt = yield* DateTime.now;
        yield* Ref.update(state, ({ listings }) => ({
          config,
          loadedAt,
          configError: null,
          listings: new Map(
            sources.map(({ id }): [string, Listing] => [
              id,
              listings.get(id) ?? { state: "pending" },
            ]),
          ),
        }));
        yield* FiberHandle.run(scheduler, generation(loaded));
      });

      yield* start(initial).pipe(Effect.orDie);

      const reload = reloading.withPermits(1)(
        Effect.gen(function* () {
          yield* FiberHandle.clear(scheduler);
          const loaded = yield* ConfigFile.load(home.config, registry).pipe(
            Effect.tapError((configError) =>
              Ref.update(state, (current) => ({ ...current, configError })),
            ),
          );
          yield* start(loaded).pipe(Effect.orDie);
          return yield* Ref.get(state);
        }),
      );

      return Daemon.of({
        home,
        port: initial.config.port ?? defaultPort,
        state: Ref.get(state),
        reload: reload.pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.uninterruptible,
        ),
        digester: Ref.get(digester),
      });
    }),
  );
