import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Layer from "effect/Layer";
import * as String from "effect/String";
import * as Migrator from "effect/sql/Migrator";
import { migration as migration0001 } from "./migrations/0001_init.ts";

export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({ "0001_init": migration0001 }),
});

export const layer = (filename: string) =>
  Layer.effectDiscard(migrate).pipe(
    Layer.provideMerge(
      SqliteClient.layer({
        filename,
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }),
    ),
  );
