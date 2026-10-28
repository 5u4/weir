import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Http from "../src/Http.ts";
import {
  adjustableClock,
  apiClient,
  eventually,
  fakePlugin,
  fakeSource,
  mailStream,
  makeHome,
  rawItem,
  sourceConfig,
} from "./harness.ts";

const tag = (name: string, match: string, ai = false) => `
[[tag]]
name = "${name}"
ai = ${ai}
match = ${match}
`;

const invoiceTitle = `{ type = "regex", target = "/title", regex = "invoice", flags = "i" }`;
const promoLabel = `{ type = "some", target = "/raw/labelIds", rule = { type = "eq", target = "", is = "PROMO" } }`;
const fromMe = `{ type = "eq", target = "/fromMe", is = true }`;

const mailbox = [
  rawItem("a1", {
    threadId: "t1",
    title: "Quarterly invoice review",
    occurredAt: "2026-10-20T09:00:00Z",
    body: "Please review the invoice batch.\n\n> old quoted text",
    bodyNew: "Please review the invoice batch.",
    raw: { labelIds: ["INBOX"] },
  }),
  rawItem("a2", {
    threadId: "t1",
    title: "Re: Quarterly invoice review",
    occurredAt: "2026-10-21T09:00:00Z",
    from: { name: "Me", address: "me@example.com" },
    body: "Approved.",
    bodyNew: "Approved.",
  }),
  rawItem("b1", {
    threadId: "t2",
    title: "Weekend sale",
    occurredAt: "2026-10-27T09:00:00Z",
    from: { name: "Deals", address: "deals@shop.example" },
    body: "Everything 30% off",
    bodyNew: "Everything 30% off",
    raw: { labelIds: ["PROMO"] },
  }),
];

const synced = <A extends { readonly sources: ReadonlyArray<{ readonly listing: string }> }>(
  status: A,
) => status.sources.every(({ listing }) => listing !== "pending");

describe("startup", () => {
  it.live("a config error names the config file and the path of each problem", () =>
    Effect.gen(function* () {
      const cases = [
        [
          sourceConfig() + tag("Bad", `{ type = "regex", target = "/title", regex = "(" }`),
          '["tag"][0]["match"]',
        ],
        [sourceConfig().replace('plugin = "fake"', 'plugin = "nope"'), '["source"][0]["plugin"]'],
        ["[[source]\n", "invalid TOML"],
      ] as const;
      for (const [body, expected] of cases) {
        const { home } = makeHome(body);
        const error = yield* Effect.flip(
          Layer.build(Http.layer(home, { fake: fakePlugin(fakeSource([])) })),
        );
        expect(error._tag).toBe("ConfigInvalid");
        expect(error.message).toContain(`invalid config ${home.config}`);
        expect(error.message).toContain(expected);
      }
    }).pipe(Effect.scoped),
  );
});

describe("reload", () => {
  it.live("a broken config stops sync but keeps reads serving until a good reload", () =>
    Effect.gen(function* () {
      const source = fakeSource(mailbox);
      const { home, port, writeConfig } = makeHome(sourceConfig());
      yield* Layer.build(Http.layer(home, { fake: fakePlugin(source) }));
      const client = yield* apiClient(port);
      yield* eventually(client.status(), synced);

      writeConfig(sourceConfig() + tag("Bad", `{ type = "nope" }`));
      const error = yield* Effect.flip(client.reload());
      expect(error._tag).toBe("ConfigInvalid");
      expect(error._tag === "ConfigInvalid" && error.file).toBe(home.config);

      const stopped = yield* client.status();
      expect(stopped.sync).toBe("stopped");
      expect(stopped.config.error?.file).toBe(home.config);
      expect(stopped.config.error?.message).toContain('["tag"][0]["match"]');
      const callsWhenStopped = source.syncCalls;
      yield* Effect.sleep(Duration.millis(300));
      expect(source.syncCalls).toBe(callsWhenStopped);
      const { conversations } = yield* client.search({ query: { q: "invoice" } });
      expect(conversations.map(({ title }) => title)).toEqual(["Quarterly invoice review"]);

      writeConfig(sourceConfig());
      yield* client.reload();
      const running = yield* client.status();
      expect(running.sync).toBe("running");
      expect(running.config.error).toBeNull();
      yield* eventually(
        Effect.sync(() => source.syncCalls),
        (calls) => calls > callsWhenStopped,
      );
      expect(source.syncCalls).toBeGreaterThan(callsWhenStopped);
    }).pipe(Effect.scoped),
  );

  it.live("tag_state and conversation tags follow the config on every reload", () =>
    Effect.gen(function* () {
      const { clock, set } = yield* adjustableClock("2026-10-28T00:00:00Z");
      yield* Effect.gen(function* () {
        const { home, port, writeConfig } = makeHome(
          sourceConfig("1h") + tag("Finance", invoiceTitle, true) + tag("Promo", promoLabel),
        );
        yield* Layer.build(Http.layer(home, { fake: fakePlugin(fakeSource(mailbox)) }));
        const client = yield* apiClient(port);
        const tags = client
          .status()
          .pipe(
            Effect.map(({ tags }) =>
              tags.map(({ name, ai_since, conversations }) => [name, ai_since, conversations]),
            ),
          );
        yield* eventually(client.status(), synced);
        expect(yield* tags).toEqual([
          ["Finance", "2026-10-28T00:00:00.000Z", 1],
          ["Promo", null, 1],
        ]);

        yield* set("2026-10-29T00:00:00Z");
        writeConfig(
          sourceConfig("1h") +
            tag("Finance", invoiceTitle, true) +
            tag(
              "Promo",
              `{ type = "regex", target = "/title", regex = "invoice|sale", flags = "i" }`,
              true,
            ),
        );
        yield* client.reload();
        expect(yield* tags).toEqual([
          ["Finance", "2026-10-28T00:00:00.000Z", 1],
          ["Promo", "2026-10-29T00:00:00.000Z", 2],
        ]);

        yield* set("2026-10-30T00:00:00Z");
        writeConfig(sourceConfig("1h") + tag("Promo", promoLabel));
        yield* client.reload();
        expect(yield* tags).toEqual([["Promo", null, 1]]);
        expect((yield* client.status()).untagged.conversations).toBe(1);

        yield* set("2026-10-31T00:00:00Z");
        writeConfig(
          sourceConfig("1h") + tag("Promo", promoLabel) + tag("Finance", invoiceTitle, true),
        );
        yield* client.reload();
        expect(yield* tags).toEqual([
          ["Promo", null, 1],
          ["Finance", "2026-10-31T00:00:00.000Z", 1],
        ]);
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, clock));
    }),
  );
});

describe("status", () => {
  it.live("a source whose first listing fails shows the error until a listing succeeds", () =>
    Effect.gen(function* () {
      const source = fakeSource(mailbox);
      let loggedIn = false;
      source.streams = async () => {
        if (!loggedIn) throw new Error("gws: not logged in");
        return [mailStream];
      };
      const { home, port } = makeHome(sourceConfig());
      yield* Layer.build(Http.layer(home, { fake: fakePlugin(source) }));
      const client = yield* apiClient(port);

      const failed = yield* eventually(client.status(), synced);
      expect(failed.sources).toEqual([
        { id: "mail", plugin: "fake", listing: "failed", error: "gws: not logged in", streams: [] },
      ]);

      loggedIn = true;
      const recovered = yield* eventually(
        client.status(),
        ({ sources }) => sources[0]?.listing === "ok",
      );
      expect(recovered.sources[0]).toMatchObject({ listing: "ok", error: null });
      expect(recovered.sources[0]?.streams).toMatchObject([
        { name: "me@example.com", last_error: null, backfill: "done" },
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("reads", () => {
  it.live("search, conversation, item and tag test answer from the synced store", () =>
    Effect.gen(function* () {
      const { clock } = yield* adjustableClock("2026-10-28T00:00:00Z");
      yield* Effect.gen(function* () {
        const config =
          sourceConfig("1h") +
          tag("Finance", invoiceTitle) +
          tag("Promo", promoLabel) +
          tag("Sent", fromMe);
        const { home, port, writeConfig } = makeHome(config);
        yield* Layer.build(Http.layer(home, { fake: fakePlugin(fakeSource(mailbox)) }));
        const client = yield* apiClient(port);
        yield* eventually(client.status(), synced);

        const titles = (query: Parameters<typeof client.search>[0]["query"]) =>
          client
            .search({ query })
            .pipe(Effect.map(({ conversations }) => conversations.map(({ title }) => title)));
        expect(yield* titles({ q: "invoice" })).toEqual(["Quarterly invoice review"]);
        expect(yield* titles({ q: "invoice", tag: "Promo" })).toEqual([]);
        expect(yield* titles({ q: "", since: Duration.days(3) })).toEqual(["Weekend sale"]);
        expect(yield* titles({ q: "", from: "deals" })).toEqual(["Weekend sale"]);
        expect(yield* titles({ q: "", source: "elsewhere" })).toEqual([]);

        const [hit] = (yield* client.search({ query: { q: "invoice" } })).conversations;
        if (hit === undefined) throw new Error("no search hit");
        const conversation = yield* client.conversation({ params: { id: hit.id } });
        expect(conversation).toMatchObject({
          title: "Quarterly invoice review",
          source: "mail",
          tags: ["Finance", "Sent"],
        });
        expect(conversation.items.map(({ from_me, body_new }) => [from_me, body_new])).toEqual([
          [false, "Please review the invoice batch."],
          [true, "Approved."],
        ]);

        const first = conversation.items[0];
        if (first === undefined) throw new Error("conversation without items");
        const item = yield* client.item({ params: { seq: first.seq } });
        expect(item.body).toContain("> old quoted text");
        expect(item.raw).toEqual({ labelIds: ["INBOX"] });
        expect((yield* Effect.flip(client.item({ params: { seq: 9999 } })))._tag).toBe("NotFound");
        expect((yield* Effect.flip(client.conversation({ params: { id: 9999 } })))._tag).toBe(
          "NotFound",
        );

        const tested = yield* client.tagTest({ query: {} });
        expect(
          tested.tags.map(({ name, conversations, items }) => [name, conversations, items]),
        ).toEqual([
          ["Finance", 1, 2],
          ["Promo", 1, 1],
          ["Sent", 1, 1],
        ]);
        expect(tested.untagged).toEqual({ conversations: 0, items: 0 });
        expect(tested.total).toEqual({ conversations: 2, items: 3 });
        expect(tested.tags[1]?.samples.map(({ title }) => title)).toEqual(["Weekend sale"]);

        const promo = yield* client.tagTest({ query: { name: "Promo" } });
        expect(promo.tags.map(({ name }) => name)).toEqual(["Promo"]);
        expect((yield* Effect.flip(client.tagTest({ query: { name: "Nope" } })))._tag).toBe(
          "NotFound",
        );

        writeConfig(config + tag("Sale", `{ type = "regex", target = "/body", regex = "30%" }`));
        const dryRun = yield* client.tagTest({ query: { name: "Sale" } });
        expect(dryRun.tags.map(({ name, conversations }) => [name, conversations])).toEqual([
          ["Sale", 1],
        ]);
        expect((yield* client.status()).tags.map(({ name }) => name)).toEqual([
          "Finance",
          "Promo",
          "Sent",
        ]);
      }).pipe(Effect.scoped, Effect.provideService(Clock.Clock, clock));
    }),
  );

  it.live("search --tag Untagged finds only conversations without a tag", () =>
    Effect.gen(function* () {
      const { home, port } = makeHome(sourceConfig("1h") + tag("Promo", promoLabel));
      yield* Layer.build(Http.layer(home, { fake: fakePlugin(fakeSource(mailbox)) }));
      const client = yield* apiClient(port);
      yield* eventually(client.status(), synced);
      for (const [tag, expected] of [
        ["Untagged", ["Quarterly invoice review"]],
        ["Promo", ["Weekend sale"]],
      ] as const) {
        const { conversations } = yield* client.search({ query: { q: "", tag } });
        expect(conversations.map(({ title }) => title)).toEqual(expected);
      }
    }).pipe(Effect.scoped),
  );
});
