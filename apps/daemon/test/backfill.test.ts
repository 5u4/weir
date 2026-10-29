import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  deliverThreads,
  expireHistory,
  readCalls,
  seedThreads,
  setDelay,
  type Thread,
} from "@weir/fixtures";
import { gws } from "@weir/plugin-gws";
import * as Database from "@weir/store/Database";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { WeirHome } from "../src/Home.ts";
import * as Http from "../src/Http.ts";
import { apiClient, eventually, makeHome } from "./harness.ts";

const fakeGws = join(import.meta.dirname, "../node_modules/.bin/fake-gws");
const pageSize = 10;
const hour = 3_600_000;

const gmailTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "+00:00");

const note = (id: string, at: number): Thread => ({
  id,
  subject: `Note ${id}`,
  labels: ["INBOX"],
  messages: [{ at: gmailTime(at), from: "priya", to: ["me"], text: `Note ${id}` }],
});

const gmailHome = (threads: number, now: number) => {
  const { home, port, writeConfig } = makeHome("");
  const mailbox = join(home.root, "mailbox");
  seedThreads(
    mailbox,
    Array.from({ length: threads }, (_, i) => note(`seed-${i}`, now - (i + 2) * hour)),
    { now: gmailTime(now), pageSize },
  );
  writeConfig(`[[source]]
id = "gmail"
plugin = "gws"
sync_every = "1h"

[source.config]
command = ${JSON.stringify([fakeGws, "--mailbox", mailbox])}
backfill = "newer_than:30d"
`);
  return { home, port, mailbox };
};

const connect = (home: WeirHome, port: number) =>
  Effect.gen(function* () {
    yield* Layer.build(Http.layer(home, { gws }));
    const client = yield* apiClient(port);
    return {
      client,
      stream: client.status().pipe(Effect.map(({ sources }) => sources[0]?.streams[0])),
      states: client
        .search({ query: { q: "" } })
        .pipe(
          Effect.map(({ conversations }) =>
            Object.fromEntries(conversations.map(({ title, state }) => [title, state])),
          ),
        ),
    };
  });

const storedCursor = (home: WeirHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ cursor: string }>`SELECT cursor FROM stream`;
    return JSON.parse(row?.cursor ?? "null");
  }).pipe(Effect.provide(Database.layer(home.db)));

const seedTitles = (n: number) => Array.from({ length: n }, (_, i) => `Note seed-${i}`);

describe("gws background backfill", () => {
  it.live("mail delivered during the backfill lands unread while the backfill still runs", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const seeded = 6 * pageSize + 1;
      const { home, port, mailbox } = gmailHome(seeded, now);
      setDelay(mailbox, { "threads list": 500 });
      const { stream, states } = yield* connect(home, port);

      yield* eventually(
        Effect.sync(() => readCalls(mailbox)),
        (calls) => calls.some(({ command }) => command === "threads list"),
        400,
      );
      deliverThreads(mailbox, [note("early", now - 60_000)]);
      expect((yield* stream)?.items).toBe(0);

      yield* eventually(stream, (s) => (s?.items ?? 0) >= pageSize, 400);
      deliverThreads(mailbox, [note("mid", now)]);
      const [elapsed, live] = yield* Effect.timed(
        eventually(states, (s) => s["Note mid"] === "unread", 160),
      );
      expect(live["Note mid"]).toBe("unread");
      expect(Duration.toMillis(elapsed)).toBeLessThan(3_000);
      expect((yield* stream)?.backfill).toBe("running");

      const done = yield* eventually(stream, (s) => s?.backfill === "done", 800);
      expect(done).toMatchObject({ backfill: "done", last_error: null, items: seeded + 2 });
      const final = yield* states;
      expect(final["Note early"]).toBe("unread");
      expect(final["Note mid"]).toBe("unread");
      expect(seedTitles(seeded).filter((title) => final[title] !== "read")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "a history 404 lists recent mail as live pages and re-backfills without losing read state",
    () =>
      Effect.gen(function* () {
        const seeded = 5;
        const { home, port, mailbox } = gmailHome(seeded, yield* Clock.currentTimeMillis);
        const { client, stream, states } = yield* connect(home, port);
        yield* eventually(stream, (s) => s?.backfill === "done", 400);
        const backfilled = yield* states;
        expect(seedTitles(seeded).map((title) => backfilled[title])).toEqual(
          seedTitles(seeded).map(() => "read"),
        );

        const { watermark } = (yield* storedCursor(home)).live;
        const now = yield* Clock.currentTimeMillis;
        expect(Math.abs(now - watermark)).toBeLessThan(60_000);
        deliverThreads(mailbox, [note("before-expiry", now)]);
        expireHistory(mailbox);
        deliverThreads(mailbox, [note("after-expiry", now + 1_000)]);
        setDelay(mailbox, { "threads list": 300 });
        const before = (yield* stream)?.items ?? 0;

        yield* client.reload();
        const seen: Array<{ items: number; backfill: string }> = [];
        for (let attempt = 0; attempt < 800; attempt++) {
          const current = yield* stream;
          if (current !== undefined) seen.push(current);
          if (seen.some((s) => s.backfill === "running") && current?.backfill === "done") break;
          yield* Effect.sleep(Duration.millis(25));
        }
        expect(seen.some((s) => s.backfill === "running")).toBe(true);
        expect(seen.at(-1)).toMatchObject({
          backfill: "done",
          last_error: null,
          items: before + 2,
        });
        expect(seen.filter((s, i) => s.items < (seen[i - 1]?.items ?? before))).toEqual([]);

        const recovered = yield* states;
        expect(recovered["Note before-expiry"]).toBe("unread");
        expect(recovered["Note after-expiry"]).toBe("unread");
        expect(seedTitles(seeded).filter((title) => recovered[title] !== "read")).toEqual([]);
        const bound = `after:${Math.floor(watermark / 1000) - 3600}`;
        expect(
          readCalls(mailbox)
            .filter(
              ({ command, params }) => command === "threads list" && params.q !== "newer_than:30d",
            )
            .map(({ params }) => params.q),
        ).toEqual([bound, bound]);
      }).pipe(Effect.scoped),
  );
});
