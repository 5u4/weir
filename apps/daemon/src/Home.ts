import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

export interface WeirHome {
  readonly root: string;
  readonly config: string;
  readonly db: string;
  readonly daemon: string;
}

export const make = (root: string): WeirHome => ({
  root,
  config: `${root}/config.toml`,
  db: `${root}/weir.db`,
  daemon: `${root}/daemon.json`,
});

export const fromEnv = Config.NonEmptyString("WEIR_HOME").pipe(
  Config.orElse(() => Config.NonEmptyString("HOME").pipe(Config.map((home) => `${home}/.weir`))),
  Config.map(make),
);

export const DaemonFile = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  pid: Schema.Int,
});
export type DaemonFile = typeof DaemonFile.Type;
