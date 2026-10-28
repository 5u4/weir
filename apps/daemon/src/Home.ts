import * as Config from "effect/Config";

export interface WeirHome {
  readonly root: string;
  readonly config: string;
  readonly db: string;
}

export const make = (root: string): WeirHome => ({
  root,
  config: `${root}/config.toml`,
  db: `${root}/weir.db`,
});

export const fromEnv = Config.NonEmptyString("WEIR_HOME").pipe(
  Config.orElse(() => Config.NonEmptyString("HOME").pipe(Config.map((home) => `${home}/.weir`))),
  Config.map(make),
);
