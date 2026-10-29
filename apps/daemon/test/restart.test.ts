import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { RawItem } from "@weir/contract/Source";
import * as Database from "@weir/store/Database";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { WeirHome } from "../src/Home.ts";
import {
  apiClient,
  digestConfig,
  eventually,
  makeHome,
  rawItem,
  readCapture,
  sourceConfig,
} from "./harness.ts";

const entry = join(import.meta.dirname, "daemon-process.ts");

const workTag = `
[[tag]]
name = "Work"
ai = true
match = { type = "regex", target = "/title", regex = "work", flags = "i" }
`;

const daemon = (home: WeirHome) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn(["bun", entry], {
          env: { ...Bun.env, WEIR_HOME: home.root },
          stdout: "ignore",
          stderr: "inherit",
        }),
      ),
      (running) =>
        Effect.promise(async () => {
          running.kill("SIGKILL");
          await running.exited;
        }),
    );
    yield* eventually(
      Effect.sync(() =>
        existsSync(home.daemon) ? JSON.parse(readFileSync(home.daemon, "utf8")).pid : null,
      ),
      (pid) => pid === child.pid,
    );
    return child;
  });

const kill = (child: Bun.Subprocess) =>
  Effect.promise(async () => {
    child.kill("SIGKILL");
    await child.exited;
  });

describe("restart", () => {
  it.live("a daemon killed mid-threshold and mid-call writes the auto range exactly once", () =>
    Effect.gen(function* () {
      const { home, port, writeConfig } = makeHome("");
      const capture = join(home.root, "capture.jsonl");
      writeConfig(sourceConfig() + digestConfig({ capture, args: ["--delay", "1500"] }) + workTag);
      const sourceFile = join(home.root, "source.json");
      const items: Array<RawItem> = [];
      const append = (externalId: string) =>
        Effect.gen(function* () {
          const text = "word ".repeat(120);
          items.push(
            rawItem(externalId, {
              threadId: "work",
              title: "Work plan",
              occurredAt: DateTime.formatIso(yield* DateTime.now),
              body: text,
              bodyNew: text,
            }),
          );
          writeFileSync(sourceFile, JSON.stringify(items));
        });
      writeFileSync(sourceFile, "[]");
      const client = yield* apiClient(port);
      const workItems = client.search({ query: { q: "" } }).pipe(
        Effect.flatMap(({ conversations }) => {
          const work = conversations.find(({ title }) => title === "Work plan");
          return work === undefined
            ? Effect.succeed([])
            : client
                .conversation({ params: { id: work.id } })
                .pipe(Effect.map((detail) => detail.items.map(({ seq }) => seq)));
        }),
      );

      const first = yield* daemon(home);
      yield* append("w1");
      yield* eventually(workItems, (seqs) => seqs.length === 1);
      yield* kill(first);

      yield* append("w2");
      const second = yield* daemon(home);
      const [s1, s2] = yield* eventually(workItems, (seqs) => seqs.length === 2);
      yield* eventually(
        Effect.sync(() => readCapture(capture)),
        (calls) => calls.length === 1,
      );
      yield* kill(second);

      yield* daemon(home);
      yield* eventually(
        Effect.sync(() => readCapture(capture)),
        (calls) => calls.length === 2,
      );
      const stored = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          digests: yield* sql<{ fromSeq: number; toSeq: number; trigger: string }>`
            SELECT from_seq, to_seq, "trigger" FROM digest`,
          runs: yield* sql<{ ok: number }>`SELECT ok FROM digest_run`,
        };
      }).pipe(Effect.provide(Database.layer(home.db)));
      yield* eventually(stored, ({ digests }) => digests.length > 0);
      yield* Effect.sleep("2 seconds");

      expect(yield* stored).toEqual({
        digests: [{ fromSeq: s1, toSeq: s2, trigger: "auto" }],
        runs: [{ ok: 1 }],
      });
      expect(readCapture(capture).map(({ input }) => input.range)).toEqual([
        { from_seq: s1, to_seq: s2 },
        { from_seq: s1, to_seq: s2 },
      ]);
    }).pipe(Effect.scoped),
  );
});
