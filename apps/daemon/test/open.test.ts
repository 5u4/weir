import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { remove, seedMailbox } from "@weir/fixtures";
import { gws } from "@weir/plugin-gws";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Http from "../src/Http.ts";
import {
  apiClient,
  eventually,
  fakePlugin,
  fakeSource,
  makeHome,
  rawItem,
  sourceConfig,
} from "./harness.ts";

const fakeGws = join(import.meta.dirname, "../node_modules/.bin/fake-gws");

describe("conversation open target", () => {
  it.live(
    "is the newest live linked gws item labelled Gmail and survives deletion and source removal",
    () =>
      Effect.gen(function* () {
        const { home, port, writeConfig } = makeHome("");
        const mailbox = join(home.root, "mailbox");
        seedMailbox(mailbox);
        writeConfig(`[[source]]
id = "gmail"
plugin = "gws"
sync_every = "100ms"

[source.config]
command = ["${fakeGws}", "--mailbox", "${mailbox}"]
backfill = "newer_than:30d"
`);
        yield* Layer.build(Http.layer(home, { gws }));
        const client = yield* apiClient(port);
        const details = yield* eventually(
          client
            .search({ query: { q: "" } })
            .pipe(
              Effect.flatMap(({ conversations }) =>
                Effect.forEach(conversations, ({ id }) => client.conversation({ params: { id } })),
              ),
            ),
          (details) => details.some(({ items }) => items.length >= 2),
        );
        const thread = details.find(({ items }) => items.length >= 2);
        if (thread === undefined) throw new Error("no multi-message conversation");
        const newest = yield* client.item({ params: { seq: thread.items.at(-1)?.seq ?? 0 } });
        const previous = yield* client.item({ params: { seq: thread.items.at(-2)?.seq ?? 0 } });
        expect(newest.link).not.toBeNull();
        expect(thread.open).toEqual({ label: "Gmail", link: newest.link });

        remove(mailbox, newest.link?.split("#all/")[1] ?? "");
        const moved = yield* eventually(
          client.conversation({ params: { id: thread.id } }),
          ({ open }) => open?.link !== newest.link,
        );
        expect(moved.open).toEqual({ label: "Gmail", link: previous.link });

        writeConfig("");
        yield* client.reload();
        const kept = yield* client.conversation({ params: { id: thread.id } });
        expect(kept.open).toEqual({ label: "Gmail", link: previous.link });
      }).pipe(Effect.scoped),
  );

  it.live("is null without links and skips a newest item that has no link", () =>
    Effect.gen(function* () {
      const { home, port } = makeHome(sourceConfig());
      const source = fakeSource([
        rawItem("a1", { threadId: "plain", title: "No links", occurredAt: "2026-10-20T09:00:00Z" }),
        rawItem("a2", { threadId: "plain", title: "No links", occurredAt: "2026-10-20T10:00:00Z" }),
        rawItem("b1", {
          threadId: "mixed",
          title: "Mixed links",
          occurredAt: "2026-10-20T09:00:00Z",
          link: "https://example.com/b1",
        }),
        rawItem("b2", {
          threadId: "mixed",
          title: "Mixed links",
          occurredAt: "2026-10-20T10:00:00Z",
          link: "https://example.com/b2",
        }),
        rawItem("b3", {
          threadId: "mixed",
          title: "Mixed links",
          occurredAt: "2026-10-20T11:00:00Z",
        }),
      ]);
      yield* Layer.build(Http.layer(home, { fake: fakePlugin(source) }));
      const client = yield* apiClient(port);
      const { conversations } = yield* eventually(
        client.search({ query: { q: "" } }),
        ({ conversations }) => conversations.length === 2,
      );
      const [plain, mixed] = yield* Effect.forEach(["No links", "Mixed links"], (title) =>
        client.conversation({
          params: { id: conversations.find((c) => c.title === title)?.id ?? 0 },
        }),
      );
      expect(plain?.open).toBeNull();
      expect(mixed?.items).toHaveLength(3);
      expect(mixed?.open).toEqual({ label: "Open", link: "https://example.com/b2" });
    }).pipe(Effect.scoped),
  );
});
