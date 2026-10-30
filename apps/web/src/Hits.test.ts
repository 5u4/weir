import { RegistryProvider } from "@effect/atom-react/RegistryContext";
import { termPattern } from "@weir/daemon/Match";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import scenarios from "../../../packages/fixtures/scenarios.json" with { type: "json" };
import {
  closedUi,
  type Detail,
  type Digest,
  type ItemSummary,
  lastSeq,
  type ReaderUi,
  reader,
  topicKey,
} from "./Blocks.ts";
import { type Hit, hitKey, hits, matchedIn, reveal } from "./Hits.ts";
import { BlockView } from "./Reader.tsx";
import { readerUi } from "./Reading.ts";
import { ConversationId } from "./Route.ts";

vi.hoisted(() => vi.stubGlobal("location", { origin: "http://weir.test", search: "" }));

const rachel = { name: "Rachel Gomez", address: "rachel.gomez@northwind.example" };
const ben = { name: "Ben Foster", address: "ben.foster@example.com" };
const lisa = { name: "Lisa Chen", address: "lisa.chen@northwind.example" };
const daniel = { name: "", address: "dan.ellis@mail.example" };

const item = (seq: number, from: ItemSummary["from"], body_new: string): ItemSummary => ({
  seq,
  occurred_at: `2026-10-20T09:${String(seq).padStart(2, "0")}:00.000Z`,
  from,
  from_me: false,
  title: null,
  body_new,
  stream: "robin.ellis@example.com",
});

const digest = (
  id: number,
  from_seq: number,
  to_seq: number,
  headline: string,
  topics: ReadonlyArray<{ title: string; body: string; seqs: ReadonlyArray<number> }>,
): Digest => ({
  id,
  conversation_id: 1,
  from_seq,
  to_seq,
  headline,
  topics: topics.map((topic) => ({ ...topic, state: "open" })),
  trigger: "auto",
  ai_profile: "fake-ai",
  created_at: "2026-10-25T16:00:00.000Z",
});

const detail = (
  items: ReadonlyArray<ItemSummary>,
  digests: ReadonlyArray<Digest> = [],
): Detail => ({
  id: 1,
  source: "gmail",
  title: "Northwind migration: cutover plan and UAT sign-off",
  first_at: items[0]?.occurred_at ?? "",
  last_at: items.at(-1)?.occurred_at ?? "",
  tags: [],
  open: null,
  state: { seen_seq: 0, cleared_seq: 0, muted: false, state: "unread" },
  items,
  digests,
  digest: { backlog: null, earlier: null, now: null, last_failure: null },
});

const northwind = detail(
  [
    item(1, rachel, "Change order CO-0147 attached. Lisa signed it this morning."),
    item(2, ben, "Approved, $1,800 from the migration budget line."),
    item(4, rachel, "I ran the test migration on your Oct 10 snapshot."),
    item(10, ben, "Robin here, nothing to add."),
    item(18, rachel, "Re-ran the migration on the Oct 20 snapshot."),
    item(21, ben, "Lisa wants the dedupe rule decided by Oct 23."),
    item(25, lisa, "Signed."),
    item(30, ben, "Go-live is Monday."),
  ],
  [
    digest(7, 10, 25, "CO-0147 signed; 37 duplicate records need a decision", [
      {
        title: "UAT and cutover",
        body: "Lisa signed CO-0147. UAT sign-off still Oct 24.",
        seqs: [10, 18, 25],
      },
      { title: "Duplicates", body: "Merge or relax the unique rule.", seqs: [21] },
    ]),
  ],
);

const momsBirthday = detail([
  item(29, daniel, "Hey Robin,\n\nI finally worked out Mom's 60th: lunch on Dec 7."),
]);

const trailPacks = detail([item(24, ben, "# 30% off trail packs, this weekend only")]);

const ledger = detail([
  item(23, ben, "Idempotency keys are not enough. The backfill (PR #4818) taught us that."),
  item(26, ben, "Unrelated follow-up."),
]);

const runbook = detail(
  [
    item(1, rachel, "Cutover runbook is in the shared drive."),
    item(2, ben, "Thanks, reading it tonight."),
    item(3, lisa, "Snapshot restore took 40 minutes on staging."),
  ],
  [
    digest(4, 1, 3, "Cutover runbook shared", [
      { title: "Runbook", body: "Rachel shared the cutover runbook; Ben reads it.", seqs: [1, 2] },
    ]),
  ],
);

const venue = detail(
  [item(29, daniel, "Booked the place by the river for Dec 7.")],
  [
    digest(5, 29, 29, "Mom's 60th lunch is set", [
      { title: "Venue booked", body: "Daniel booked a riverside place for Dec 7.", seqs: [29] },
    ]),
  ],
);

const found = (of: Detail, query: string) => hits(of, termPattern(query));

const describeHit = (hit: Hit) =>
  hit._tag === "Item"
    ? `item ${hit.seq} ${hit.field}`
    : hit._tag === "Topic"
      ? `topic ${hit.key}`
      : `headline ${hit.digest}`;

const outer = (markup: string, key: string) => {
  const at = markup.indexOf(`data-hit="${key}"`);
  if (at === -1) return null;
  const rest = markup.slice(markup.lastIndexOf("<", at));
  const tag = /^<(\w+)/.exec(rest)?.[1] ?? "";
  let depth = 0;
  for (const match of rest.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "g"))) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return rest.slice(0, match.index + match[0].length);
  }
  return null;
};

const rendered = (
  of: Detail,
  ui: ReaderUi,
  found: {
    readonly pattern: RegExp | null;
    readonly hits: ReadonlyMap<string, Hit>;
    readonly current: string | null;
  },
) => {
  const id = ConversationId.make(of.id);
  return renderToStaticMarkup(
    createElement(
      RegistryProvider,
      { initialValues: [[readerUi(id), ui]] },
      reader(of, lastSeq(of), ui, null).map((block, at) =>
        createElement(BlockView, {
          key: at,
          id,
          block,
          watch: () => () => {},
          mark: { seen: lastSeq(of), unread: () => {} },
          found,
          controls: null,
          tint: "ink",
          lead: at === 0,
        }),
      ),
    ),
  );
};

const revealed = (of: Detail, query: string) => {
  const pattern = termPattern(query);
  const all = hits(of, pattern);
  const keyed = new Map(all.map((hit) => [hitKey(hit), hit]));
  return all.map((hit) => {
    const key = hitKey(hit);
    const markup = rendered(of, reveal(closedUi, of, hit), { pattern, hits: keyed, current: key });
    return { key, target: outer(markup, key) };
  });
};

const landedOn = (of: Detail, query: string) =>
  revealed(of, query).map(
    ({ key, target }) =>
      `${key} ${target === null ? "missing" : /<mark>|title="Matched in /.test(target) ? "marked" : "unmarked"}`,
  );

describe("hits", () => {
  it.each([
    ["migrat", northwind, ["item 2 body", "item 4 body", "item 18 body"]],
    ["MIGRAT", northwind, ["item 2 body", "item 4 body", "item 18 body"]],
    ["northwind", northwind, ["item 1 from", "item 4 from", "item 18 from", "item 25 from"]],
    ["lisa", northwind, ["item 1 body", "topic 7:0", "item 25 from", "item 21 body"]],
    ["60", momsBirthday, ["item 29 body"]],
    ["60", trailPacks, []],
    ["idempotency backfill", ledger, ["item 23 body"]],
    ["(PR", ledger, ["item 23 body"]],
    ["dan.ellis", momsBirthday, ["item 29 from"]],
  ] as const)("%s finds its targets in document order", (query, of, expected) => {
    expect(found(of, query).map(describeHit)).toEqual(expected);
  });

  it("counts a two-character term like any other", () => {
    expect(found(momsBirthday, "60")).toHaveLength(1);
    expect(found(trailPacks, "30")).toEqual([{ _tag: "Item", seq: 24, field: "body" }]);
  });

  it("a digest topic that matches is its own hit, before the originals it covers", () => {
    expect(found(northwind, "UAT").map(describeHit)).toEqual(["topic 7:0"]);
    expect(found(northwind, "signed").map(describeHit)).toEqual([
      "item 1 body",
      "headline 7",
      "topic 7:0",
      "item 25 body",
    ]);
  });

  it("matches the sender as name <address>, the text the daemon searches", () => {
    expect(found(northwind, "Gomez").map(describeHit)).toEqual([
      "item 1 from",
      "item 4 from",
      "item 18 from",
    ]);
    expect(found(northwind, "<rachel.gomez@").map(describeHit)).toEqual([
      "item 1 from",
      "item 4 from",
      "item 18 from",
    ]);
  });

  it("a matching headline is one hit for its card", () => {
    expect(found(northwind, "duplicate").map(describeHit)).toEqual(["headline 7", "topic 7:1"]);
  });

  it("counts a match in the source as an item hit, after the body and the sender", () => {
    expect(found(northwind, "robin.ellis").map(describeHit)).toEqual([
      "item 1 source",
      "item 2 source",
      "item 4 source",
      "item 10 source",
      "item 18 source",
      "item 25 source",
      "item 21 source",
      "item 30 source",
    ]);
    expect(found(northwind, "example.com").map(describeHit)).toEqual([
      "item 1 source",
      "item 2 from",
      "item 4 source",
      "item 10 from",
      "item 18 source",
      "item 25 source",
      "item 21 from",
      "item 30 from",
    ]);
    expect(found(northwind, "Robin").map(describeHit)).toContain("item 10 body");
  });

  it("does not count a match only in the title, and says the title matched", () => {
    expect(found(northwind, "sign-off")).toEqual([
      { _tag: "Topic", key: topicKey(northwind.digests[0] as Digest, 0) },
    ]);
    expect(found(northwind, "cutover plan")).toEqual([
      { _tag: "Topic", key: topicKey(northwind.digests[0] as Digest, 0) },
    ]);
    expect(found(momsBirthday, "cutover")).toEqual([]);
    expect(matchedIn(momsBirthday, termPattern("cutover"))).toBe("Matched in Title");
    expect(matchedIn(momsBirthday, termPattern("gmail"))).toBe("Matched the conversation");
    expect(matchedIn(momsBirthday, null)).toBe("Matched in filters");
  });

  it("finds nothing without a text term", () => {
    expect(hits(northwind, termPattern(""))).toEqual([]);
    expect(hits(northwind, null)).toEqual([]);
  });
});

describe("landing on a hit", () => {
  it.each([
    ["migrat", northwind],
    ["northwind", northwind],
    ["robin.ellis", northwind],
    ["lisa", northwind],
    ["signed", northwind],
    ["duplicate", northwind],
    ["60", momsBirthday],
    ["dan.ellis", momsBirthday],
    ["idempotency backfill", ledger],
    ["snapshot", runbook],
    ["runbook", runbook],
    ["venue", venue],
  ] as const)("%s: every counted hit shows a marked target once revealed", (query, of) => {
    const counted = hits(of, termPattern(query)).map((hit) => `${hitKey(hit)} marked`);
    expect(counted.length).toBeGreaterThan(0);
    expect(landedOn(of, query)).toEqual(counted);
  });

  it("tags a bubble with the field that matched when it is not the body", () => {
    const tags = (query: string) =>
      revealed(northwind, query).map(
        ({ key, target }) =>
          `${key} ${
            /<span class="[^"]*" title="(Matched in [^"]*)">([^<]*)<\/span>/
              .exec(target ?? "")
              ?.slice(1)
              .join(" / ") ?? "no tag"
          }`,
      );
    expect(tags("example.com").slice(0, 2)).toEqual([
      "i:1 Matched in Source / Source",
      "i:2 Matched in Sender / Sender",
    ]);
    expect(tags("migrat")[0]).toBe("i:2 no tag");
  });
});

const newsletterBody =
  scenarios.threads.find(({ id }) => id === "newsletter-trailhead")?.messages[0]?.text ?? "";
const newsletter = detail([
  item(1, { name: "Trailhead Weekly", address: "issues@trailhead-weekly.example" }, newsletterBody),
]);

describe("newsletter body", () => {
  it.each([
    ["link text", "Lamport"],
    ["alt of a linked image", "Quiltwork"],
    ["alt of an image", "thousand"],
    ["heading", "months"],
    ["inline code", "mergeClocks"],
    ["HTML shown as text", "<b>raw"],
    ["list item", "tombstones"],
  ])("a query on the %s is a body hit marked in the rendered body", (_, query) => {
    expect(hits(newsletter, termPattern(query))).toEqual([{ _tag: "Item", seq: 1, field: "body" }]);
    expect(landedOn(newsletter, query)).toEqual(["i:1 marked"]);
  });

  it.each([
    ["a link target", "lamport-primer"],
    ["the hidden part of a long URL", "utm_campaign"],
    ["an image source", "banner.png"],
    ["an empty-alt image source", "robin.gif"],
    ["an image host", "cdn.trailhead"],
  ])("a query only on %s is no hit", (_, query) => {
    expect(newsletterBody).toContain(query);
    expect(hits(newsletter, termPattern(query))).toEqual([]);
  });

  it("renders without images, unsafe links, empty links or live HTML", () => {
    const unsafe = detail([
      item(
        1,
        newsletter.items[0]?.from ?? daniel,
        `${newsletterBody}\n\n[run](javascript:alert(1))`,
      ),
    ]);
    const markup = rendered(unsafe, closedUi, { pattern: null, hits: new Map(), current: null });
    expect(markup).toContain('class="body clip"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("src=");
    expect(markup).not.toContain("javascript:");
    expect(markup).toContain("<p>run</p>");
    const links = [...markup.matchAll(/<a\b[^>]*>(.*?)<\/a>/g)];
    expect(links.length).toBeGreaterThan(0);
    for (const [, text] of links) expect(text?.replace(/<[^>]+>/g, "").trim()).not.toBe("");
    expect(markup).toContain("&lt;b&gt;raw tags&lt;/b&gt;");
    expect(markup).toContain('title="https://trailhead-weekly.example/issues/48/offline-sync');
    expect(markup).toContain('class="b-img"');
  });

  it("a long body starts clipped and opens when a search lands on it", () => {
    const found = { pattern: null, hits: new Map(), current: null };
    const closed = rendered(newsletter, closedUi, found);
    expect(closed).toContain('<div class="body clip">');
    expect(closed).toContain('aria-expanded="false">Show all</button>');
    const landed = reveal(closedUi, newsletter, { _tag: "Item", seq: 1, field: "body" });
    const open = rendered(newsletter, landed, found);
    expect(open).toContain('<div class="body clip open">');
    expect(open).toContain('aria-expanded="true">Show less</button>');
  });
});

describe("reveal", () => {
  const [first] = northwind.digests as [Digest];

  it("opens the card, only the topic that cites a covered original, and its body", () => {
    const shown = reveal(closedUi, northwind, { _tag: "Item", seq: 21, field: "body" });
    expect(shown.shapes.get(first.id)).toBe("card");
    expect([...shown.originals]).toEqual([topicKey(first, 1)]);
    expect([...shown.long]).toEqual([21]);
  });

  it("keeps originals the reader already opened", () => {
    const opened = { ...closedUi, originals: new Set([topicKey(first, 0)]) };
    const shown = reveal(opened, northwind, { _tag: "Item", seq: 21, field: "body" });
    expect([...shown.originals]).toEqual([topicKey(first, 0), topicKey(first, 1)]);
  });

  it("opens the card for a topic or headline hit without unfolding originals", () => {
    for (const hit of [
      { _tag: "Topic", key: topicKey(first, 0) },
      { _tag: "Headline", digest: first.id },
    ] as const) {
      const shown = reveal({ ...closedUi, shapes: new Map([[first.id, "row"]]) }, northwind, hit);
      expect(shown.shapes.get(first.id)).toBe("card");
      expect(shown.originals.size).toBe(0);
    }
  });

  it("opens only the body of an original outside any digest", () => {
    const shown = reveal(closedUi, northwind, { _tag: "Item", seq: 2, field: "body" });
    expect(shown).toEqual({ ...closedUi, long: new Set([2]) });
    expect(reveal(shown, northwind, { _tag: "Item", seq: 2, field: "body" })).toBe(shown);
  });

  it("leaves the reader as it is for a sender hit outside any digest", () => {
    expect(reveal(closedUi, northwind, { _tag: "Item", seq: 2, field: "from" })).toBe(closedUi);
  });
});
