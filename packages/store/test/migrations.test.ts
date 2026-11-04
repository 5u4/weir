import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as Database from "../src/Database.ts";
import { tempDbFile } from "./fixtures.ts";

const frozen: Record<string, string> = {
  "0001_init.ts": "78241658080be47056d66c5f27f1dc7396a1f16460a27ab42f22d681f39ba43f",
};

const ordered = Object.entries(Database.migrations).sort(([a], [b]) => a.localeCompare(b));
const ids = ordered.map(([key]) => Number(key.split("_")[0]));

describe("migrations", () => {
  it.effect("a database at any migration upgrades to the latest", () =>
    Effect.forEach(
      ordered.map((_, index) => index + 1),
      (k) =>
        Effect.gen(function* () {
          yield* Migrator.make({})({
            loader: Migrator.fromRecord(Object.fromEntries(ordered.slice(0, k))),
          });
          const applied = yield* Database.migrate;
          expect(applied.map(([id]) => id)).toEqual(ids.slice(k));
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ migrationId: number }>`
            SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id
          `;
          expect(rows.map((row) => row.migrationId)).toEqual(ids);
        }).pipe(Effect.provide(Database.clientLayer(tempDbFile()))),
      { discard: true },
    ),
  );

  it("merged migrations keep their content", () => {
    for (const [file, hash] of Object.entries(frozen)) {
      const content = readFileSync(new URL(`../src/migrations/${file}`, import.meta.url));
      expect(createHash("sha256").update(content).digest("hex"), file).toBe(hash);
    }
  });
});
