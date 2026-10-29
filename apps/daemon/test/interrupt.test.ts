import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { seedMailbox, setDelay } from "@weir/fixtures";
import { gws } from "@weir/plugin-gws";
import * as Database from "@weir/store/Database";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { Status } from "../src/Api.ts";
import type { WeirHome } from "../src/Home.ts";
import * as Http from "../src/Http.ts";
import { apiClient, eventually, makeHome, openEvents, spawnDaemon } from "./harness.ts";

const fakeGws = join(import.meta.dirname, "../node_modules/.bin/fake-gws");
const pageSize = 10;
const listDelay = 2_000;

const slowMailbox = (home: WeirHome, writeConfig: (body: string) => void) => {
  const mailbox = join(home.root, "mailbox");
  seedMailbox(mailbox);
  setDelay(mailbox, { "messages list": listDelay });
  writeConfig(`[[source]]
id = "gmail"
plugin = "gws"
sync_every = "1h"

[source.config]
command = ${JSON.stringify([fakeGws, "--mailbox", mailbox])}
backfill = "newer_than:30d"
`);
  const messages = JSON.parse(readFileSync(join(mailbox, "mailbox.json"), "utf8")).messages;
  return Object.keys(messages).toSorted();
};

const stream = (status: Status) => status.sources[0]?.streams[0];

const midBackfill = (status: Status) => {
  const current = stream(status);
  return current !== undefined && current.items >= pageSize && current.backfill === "running";
};

const backfilled = (status: Status) => stream(status)?.backfill === "done";

const storedIds = (home: WeirHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ externalId: string }>`SELECT external_id FROM item`;
    return rows.map(({ externalId }) => externalId).toSorted();
  }).pipe(Effect.provide(Database.layer(home.db)));

describe("interrupting a sync pass", () => {
  it.live("reload mid-backfill returns after the in-flight page and the next pass resumes", () =>
    Effect.gen(function* () {
      const { home, port, writeConfig } = makeHome("");
      const messageIds = slowMailbox(home, writeConfig);
      yield* Layer.build(Http.layer(home, { gws }));
      const client = yield* apiClient(port);
      const events = yield* openEvents(port);
      expect(midBackfill(yield* eventually(client.status(), midBackfill, 400))).toBe(true);

      const [elapsed] = yield* Effect.timed(client.reload());
      const atReload = stream(yield* client.status());
      expect(Duration.toMillis(elapsed)).toBeLessThan(listDelay);
      expect((atReload?.items ?? -1) % pageSize).toBe(0);
      expect(atReload?.last_error).toBeNull();

      const outcomes: Array<string> = [];
      while (outcomes.length === 0) {
        const frame = yield* events.take;
        if (frame === "end") throw new Error("/events ended");
        if (
          frame.kind === "event" &&
          frame.event.type === "sync" &&
          frame.event.status !== "started"
        )
          outcomes.push(frame.event.status);
      }
      expect(outcomes).toEqual(["done"]);
      const done = stream(yield* client.status());
      expect(done).toMatchObject({ backfill: "done", last_error: null, items: messageIds.length });
      expect(yield* storedIds(home)).toEqual(messageIds);
    }).pipe(Effect.scoped),
  );

  it.live("SIGTERM mid-page exits within the page and a restart resumes without duplicates", () =>
    Effect.gen(function* () {
      const { home, port, writeConfig } = makeHome("");
      const messageIds = slowMailbox(home, writeConfig);
      const client = yield* apiClient(port);
      const first = yield* spawnDaemon(home);
      expect(midBackfill(yield* eventually(client.status(), midBackfill, 400))).toBe(true);

      const [elapsed] = yield* Effect.timed(
        Effect.promise(() => {
          first.kill("SIGTERM");
          return first.exited;
        }),
      );
      expect(Duration.toMillis(elapsed)).toBeLessThan(listDelay);

      yield* spawnDaemon(home);
      const done = stream(yield* eventually(client.status(), backfilled, 800));
      expect(done).toMatchObject({ backfill: "done", last_error: null, items: messageIds.length });
      expect(yield* storedIds(home)).toEqual(messageIds);
    }).pipe(Effect.scoped),
  );
});
