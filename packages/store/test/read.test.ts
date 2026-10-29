import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { conversations } from "../src/Read.ts";
import { storeLayer } from "./fixtures.ts";

interface PlanRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

describe("read", () => {
  it.effect("the latest-digest lookup for list rows searches an index without sorting", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const statements: Array<Statement.Statement<unknown>> = [];
      yield* conversations({ _tag: "Untagged" }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          statements.push(statement);
          return Effect.succeed(statement);
        }),
      );
      const [listing] = statements;
      if (listing === undefined) return expect.unreachable();
      const [text, params] = listing.compile();
      const plan = yield* sql.unsafe<PlanRow>(`EXPLAIN QUERY PLAN ${text}`, params);

      const lookups = plan.filter(({ detail }) => /\bdigest\b/u.test(detail));
      expect(lookups.map(({ detail }) => detail)).toEqual([
        "SEARCH digest USING INDEX digest_conversation_range (conversation_id=?)",
      ]);
      const siblings = plan.filter(({ parent }) => lookups.some((row) => row.parent === parent));
      expect(siblings.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
    }).pipe(Effect.provide(storeLayer())),
  );
});
