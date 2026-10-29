import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RawItem, type Source, StreamDescriptor, SyncPage } from "@weir/contract/Source";
import {
  deliver,
  deliverThreads,
  expireHistory,
  FIXTURE_NOW,
  readCalls,
  relabel,
  remove,
  seedMailbox,
  seedThreads,
  setDelay,
  setQuota,
  type Thread,
} from "@weir/fixtures";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import scenarios from "../../../packages/fixtures/scenarios.json" with { type: "json" };
import { abortableSleep, GwsError, Message, type MessagePart, type Sleep } from "../src/gws.ts";
import { createSource, type GwsConfig, gws } from "../src/index.ts";

const FAKE_GWS = join(import.meta.dirname, "../node_modules/.bin/fake-gws");
const ME = "robin.ellis@example.com";
const EVERY_LABEL: GwsConfig["labels"] = ["INBOX", "SENT", "CATEGORY_PROMOTIONS"];
const NORTHWIND = "Northwind migration: cutover plan and UAT sign-off";
const RIDGEWAY = "Robin, your weekend list: 30% off trail packs ends Sunday";
const SALTMARSH = "Last call: 2 nights for the price of 1 in Lisbon";
const strict = { onExcessProperty: "error" } as const;
const decodePage = Schema.decodeUnknownSync(SyncPage, strict);
const decodeStream = Schema.decodeUnknownSync(StreamDescriptor, strict);
const decodeMessage = Schema.decodeUnknownSync(Message);
const decodeThreadJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Message) })),
);

const dirs: string[] = [];
const seeded = (until?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "weir-gws-"));
  dirs.push(dir);
  seedMailbox(dir, until === undefined ? {} : { until });
  return dir;
};
const seedSized = (
  threads: ReadonlyArray<{ subject: string; size: number; labels?: string[] }>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "weir-gws-"));
  dirs.push(dir);
  const newest = Date.parse(FIXTURE_NOW);
  const { delivered } = seedThreads(
    dir,
    threads.map(({ subject, size, labels = ["INBOX"] }, slot) => ({
      id: subject,
      subject,
      labels,
      messages: Array.from({ length: size }, (_, k) => ({
        at: new Date(newest - (slot + 1) * 86_400_000 - (size - 1 - k) * 60_000)
          .toISOString()
          .replace(/\.\d+Z$/, "+00:00"),
        from: "priya",
        to: ["me"],
        text: `${subject} note ${k}`,
      })),
    })),
    { now: FIXTURE_NOW, pageSize: 100 },
  );
  return { dir, delivered };
};
const threadGets = (dir: string, since = 0) =>
  readCalls(dir)
    .slice(since)
    .filter(({ command }) => command === "threads get")
    .map(({ params }) => params.id);
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sourceFor = (dir: string, labels = EVERY_LABEL): Source =>
  gws.create({ command: [FAKE_GWS, "--mailbox", dir], backfill: "newer_than:30d", labels });

const running = new AbortController().signal;

const syncPage = async (source: Source, cursor: string | null) =>
  decodePage(await source.sync(ME, cursor, running));

const syncAll = async (source: Source, cursor: string | null) => {
  const pages: SyncPage[] = [];
  let next = cursor;
  for (;;) {
    const page = await syncPage(source, next);
    pages.push(page);
    next = page.cursor;
    if (!page.more) break;
  }
  const items = new Map<string, RawItem>();
  for (const page of pages) for (const item of page.upserts) items.set(item.externalId, item);
  return { pages, items, cursor: next };
};

const subjectOf = (item: RawItem) => item.title?.replace(/^Re: /, "");
const idsWithSubject = (items: Map<string, RawItem>, subject: string) =>
  [...items.values()].filter((i) => subjectOf(i) === subject).map((i) => i.externalId);
const passKinds = (pages: SyncPage[]) =>
  pages.map((_, i) =>
    i === pages.length - 1
      ? ["live", "done"]
      : i === pages.length - 2
        ? ["backfill", "done"]
        : i % 2 === 0
          ? ["backfill", "running"]
          : ["live", "running"],
  );
const gmailTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "+00:00");
const freshThread = (id: string, agoMs = 0): Thread => ({
  id,
  subject: `Fresh ${id}`,
  labels: ["INBOX"],
  messages: [
    {
      at: gmailTime(Effect.runSync(Clock.currentTimeMillis) - agoMs),
      from: "priya",
      to: ["me"],
      text: `Fresh note ${id}`,
    },
  ],
});

const rawMessage = (dir: string, item: RawItem) => {
  const proc = Bun.spawnSync([
    FAKE_GWS,
    "--mailbox",
    dir,
    "gmail",
    "users",
    "threads",
    "get",
    "--params",
    JSON.stringify({ userId: "me", id: item.threadId, format: "full" }),
  ]);
  const message = decodeThreadJson(proc.stdout.toString()).messages.find(
    (m) => m.id === item.externalId,
  );
  if (!message) throw new Error(`fake-gws has no message ${item.externalId}`);
  return message;
};

const partsOf = (part: MessagePart): MessagePart[] => [
  part,
  ...(part.parts ?? []).flatMap(partsOf),
];
const headerValues = (payload: MessagePart, name: string) =>
  (payload.headers ?? []).filter((h) => h.name.toLowerCase() === name).map((h) => h.value);

describe("gws plugin against fake-gws", () => {
  it("describes the mailbox as one stream", async () => {
    const stream = decodeStream((await sourceFor(seeded()).streams())[0]);
    expect(stream).toMatchObject({ id: ME, name: ME, kind: "message", openLabel: "Gmail" });
    expect(stream.me).toContain(ME);
  });

  it("cold-starts every message over several pages", async () => {
    const { pages, items, cursor } = await syncAll(sourceFor(seeded()), null);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.slice(0, -1).every((p) => p.more)).toBe(true);
    expect(pages.map(({ kind, backfill }) => [kind, backfill])).toEqual(passKinds(pages));
    expect(items.size).toBe(32);
    expect(new Set([...items.values()].map((i) => i.threadId)).size).toBe(15);
    expect(pages.flatMap((p) => p.deletions)).toEqual([]);
    expect(JSON.parse(cursor ?? "")).toMatchObject({
      phase: "incremental",
      labels: ["CATEGORY_PROMOTIONS", "INBOX", "SENT"],
      live: { pageToken: null },
    });
    const item = [...items.values()][0];
    expect(item?.link).toBe(
      `https://mail.google.com/mail/?authuser=${encodeURIComponent(ME)}#all/${item?.externalId}`,
    );
    expect(item?.containerId).toBe(ME);
    expect(item?.containerName).toBe("Gmail");
  });

  it("backfills whole threads that carry a configured label, my SENT-only replies included", async () => {
    const { items, cursor } = await syncAll(sourceFor(seeded(), ["INBOX"]), null);
    const subjects = [...items.values()].map(subjectOf);
    expect(subjects).not.toContain(RIDGEWAY);
    expect(subjects).not.toContain(SALTMARSH);
    expect(items.size).toBe(30);
    expect(new Set([...items.values()].map((i) => i.threadId)).size).toBe(13);
    const sentOnly = [...items.values()].filter(
      (i) => decodeMessage(i.raw).labelIds?.join() === "SENT",
    );
    expect(sentOnly.map(subjectOf)).toEqual([NORTHWIND, NORTHWIND, NORTHWIND]);
    expect(JSON.parse(cursor ?? "")).toMatchObject({ phase: "incremental", labels: ["INBOX"] });
  });

  it("resolves a user label by its Gmail name", async () => {
    const { items, cursor } = await syncAll(sourceFor(seeded(), ["Receipts"]), null);
    expect([...items.values()].map((i) => i.title).sort()).toEqual(
      scenarios.threads
        .filter((t) => t.id.startsWith("bank-"))
        .map((t) => t.subject)
        .sort(),
    );
    expect(JSON.parse(cursor ?? "")).toMatchObject({ labels: ["Label_1"] });
  });

  it("fails the sync naming a label Gmail does not have", async () => {
    const source = sourceFor(seeded(), ["INBOX", "Nope"]);
    await expect(source.sync(ME, null, running)).rejects.toThrow('Gmail has no label named "Nope"');
  });

  it.each(["SPAM", "TRASH"])("fails the sync naming the hidden label %s", async (label) => {
    const source = sourceFor(seeded(), ["INBOX", label]);
    await expect(source.sync(ME, null, running)).rejects.toThrow(
      `weir does not sync the Gmail label "${label}"`,
    );
  });

  it("ends a backfill page at the first batch reaching 100 messages and lands a long thread whole", async () => {
    const subjects = Array.from({ length: 11 }, (_, i) => (i === 7 ? "Long" : `Short ${i}`));
    const { dir, delivered } = seedSized(
      subjects.map((subject) => ({ subject, size: subject === "Long" ? 150 : 12 })),
    );

    const { pages, items } = await syncAll(sourceFor(dir, ["INBOX"]), null);
    expect(pages.map(({ kind }) => kind)).toEqual(["backfill", "live", "backfill", "live"]);
    const backfills = pages.filter((page) => page.kind === "backfill");
    expect(backfills.map((page) => [...new Set(page.upserts.map(subjectOf))])).toEqual([
      subjects.slice(0, 8),
      subjects.slice(8),
    ]);
    expect(backfills.map((page) => page.upserts.length)).toEqual([7 * 12 + 150, 3 * 12]);
    expect(backfills[0]?.upserts.filter((item) => subjectOf(item) === "Long")).toHaveLength(150);
    expect(items.size).toBe(delivered);
    const fetched = threadGets(dir);
    expect(fetched).toHaveLength(subjects.length);
    expect(new Set(fetched).size).toBe(subjects.length);
  });

  it("re-lists a backfill page so a thread that lost its label does not hide the next one", async () => {
    const subjects = [
      "First",
      ...Array.from({ length: 6 }, (_, i) => `Short ${i}`),
      "Long",
      "Last",
    ];
    const sizes: Record<string, number> = { First: 1, Long: 100 };
    const { dir } = seedSized(subjects.map((subject) => ({ subject, size: sizes[subject] ?? 2 })));
    const source = sourceFor(dir, ["INBOX"]);

    const first = await syncPage(source, null);
    expect([...new Set(first.upserts.map(subjectOf))]).toEqual(subjects.slice(0, 8));
    expect(first).toMatchObject({ more: true, kind: "backfill", backfill: "running" });
    const [moved] = first.upserts.filter((item) => subjectOf(item) === "First");
    relabel(dir, moved?.externalId ?? "", { remove: ["INBOX"] });

    const rest = await syncAll(source, first.cursor);
    expect(rest.pages.flatMap((page) => page.upserts.map(subjectOf))).toEqual(["Last", "Last"]);
    const fetched = threadGets(dir);
    expect(fetched).toHaveLength(subjects.length);
    expect(new Set(fetched).size).toBe(subjects.length);
  });

  it("bounds a live page like a backfill page and fetches the rest after a restart", async () => {
    const subjects = Array.from({ length: 10 }, (_, i) => `Starred ${i}`);
    const { dir, delivered } = seedSized(
      subjects.map((subject) => ({ subject, size: 13, labels: ["STARRED"] })),
    );
    const starred = await syncAll(sourceFor(dir, ["STARRED"]), null);
    const cold = await syncAll(sourceFor(dir, ["INBOX"]), null);
    expect(cold.items.size).toBe(0);
    for (const subject of subjects) {
      relabel(dir, idsWithSubject(starred.items, subject)[0] ?? "", { add: ["INBOX"] });
    }
    const since = readCalls(dir).length;

    const first = await syncPage(sourceFor(dir, ["INBOX"]), cold.cursor);
    expect(first).toMatchObject({ more: true, kind: "live", backfill: "done" });
    expect(first.upserts).toHaveLength(8 * 13);

    const restarted = sourceFor(dir, ["INBOX"]);
    const rest = await syncAll(restarted, first.cursor);
    expect(rest.pages.map(({ kind, more }) => [kind, more])).toEqual([["live", false]]);
    expect(rest.pages[0]?.upserts).toHaveLength(2 * 13);
    const stored = new Set([...first.upserts, ...rest.items.values()].map((i) => i.externalId));
    expect(stored.size).toBe(delivered);

    const idle = await syncPage(restarted, rest.cursor);
    expect(idle).toMatchObject({ upserts: [], deletions: [], more: false });
    const fetched = threadGets(dir, since);
    expect(fetched).toHaveLength(subjects.length);
    expect(new Set(fetched).size).toBe(subjects.length);
  });

  it("follows history only for threads that carry a configured label", async () => {
    const dir = seeded("2026-10-23T07:00:00-07:00");
    const [saltmarsh] = idsWithSubject((await syncAll(sourceFor(dir), null)).items, SALTMARSH);
    if (!saltmarsh) throw new Error("no saltmarsh promo delivered");
    const source = sourceFor(dir, ["INBOX"]);
    const cold = await syncAll(source, null);
    expect(cold.items.has(saltmarsh)).toBe(false);

    const [ridgeway] = deliver(dir);
    let page = await syncPage(source, cold.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [], kind: "live", backfill: "done" });

    relabel(dir, ridgeway ?? "", { add: ["INBOX"] });
    page = await syncPage(source, page.cursor);
    expect(page.upserts.map((i) => i.externalId)).toEqual([ridgeway]);
    expect(page.upserts.map(subjectOf)).toEqual([RIDGEWAY]);

    relabel(dir, ridgeway ?? "", { add: ["STARRED"] });
    page = await syncPage(source, page.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [] });

    remove(dir, saltmarsh);
    page = await syncPage(source, page.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [saltmarsh] });

    const [reply] = deliver(dir);
    page = await syncPage(source, page.cursor);
    expect(page.upserts.map((i) => i.externalId).sort()).toEqual(
      [...idsWithSubject(cold.items, NORTHWIND), reply].sort(),
    );
    expect(
      page.upserts.filter((i) => decodeMessage(i.raw).labelIds?.join() === "SENT"),
    ).toHaveLength(3);

    const idle = await syncPage(source, page.cursor);
    expect(idle).toMatchObject({
      upserts: [],
      deletions: [],
      more: false,
      kind: "live",
      backfill: "done",
    });
    expect(JSON.parse(idle.cursor).live).toMatchObject({
      historyId: JSON.parse(page.cursor).live.historyId,
      pageToken: null,
    });
  });

  it("alternates backfill pages with live pages that pick up mail delivered mid-backfill", async () => {
    const dir = seeded();
    const source = sourceFor(dir);
    const first = await syncPage(source, null);
    expect(first).toMatchObject({ kind: "backfill", backfill: "running", more: true });
    const startHistoryId = JSON.parse(first.cursor).live.historyId;
    const [fresh] = deliverThreads(dir, [freshThread("mid-backfill")]);

    const live = await syncPage(source, first.cursor);
    expect(live).toMatchObject({ kind: "live", backfill: "running", more: true });
    expect(live.upserts.map((i) => i.externalId)).toEqual([fresh]);

    const rest = await syncAll(source, live.cursor);
    const pages = [first, live, ...rest.pages];
    expect(pages.map(({ kind, backfill }) => [kind, backfill])).toEqual(passKinds(pages));
    expect(new Set(pages.flatMap((p) => p.upserts.map((i) => i.externalId))).size).toBe(33);
    expect(JSON.parse(rest.cursor ?? "")).toMatchObject({
      phase: "incremental",
      live: { historyId: String(Number(startHistoryId) + 1), pageToken: null },
    });
  });

  it("re-backfills from a fresh listing when the configured labels change", async () => {
    const dir = seeded();
    const inbox = await syncAll(sourceFor(dir, ["INBOX"]), null);
    const widened = await syncAll(sourceFor(dir, ["INBOX", "CATEGORY_PROMOTIONS"]), inbox.cursor);
    const [replay, ...relisted] = widened.pages;
    expect(replay).toMatchObject({ kind: "live", backfill: "running", upserts: [] });
    expect(relisted.map(({ kind, backfill }) => [kind, backfill])).toEqual(passKinds(relisted));
    expect(widened.items.size).toBe(32);
    expect(JSON.parse(widened.cursor ?? "")).toMatchObject({
      phase: "incremental",
      labels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    const reordered = await syncPage(
      sourceFor(dir, ["CATEGORY_PROMOTIONS", "INBOX", "INBOX"]),
      widened.cursor,
    );
    expect(reordered).toMatchObject({ upserts: [], kind: "live", backfill: "done" });
    expect(JSON.parse(reordered.cursor)).toMatchObject({
      phase: "incremental",
      labels: ["CATEGORY_PROMOTIONS", "INBOX"],
      live: { historyId: JSON.parse(widened.cursor ?? "").live.historyId },
    });
  });

  it("returns the scenario text as bodyNew for every message", async () => {
    const people: Record<string, { addr: string }> = scenarios.people;
    const expected = new Map(
      scenarios.threads.flatMap((t) =>
        t.messages.map((m) => [`${Date.parse(m.at)} ${people[m.from]?.addr}`, m.text.trim()]),
      ),
    );
    expect(expected.size).toBe(32);
    const { items } = await syncAll(sourceFor(seeded()), null);
    for (const item of items.values()) {
      const key = `${Date.parse(item.occurredAt)} ${item.from.address}`;
      expect(item.bodyNew?.trim(), key).toBe(expected.get(key));
    }
  });

  it("keeps quoted history and signatures in body", async () => {
    const { items } = await syncAll(sourceFor(seeded()), null);
    const reply = [...items.values()].find((i) => i.title === `Re: ${NORTHWIND}`);
    expect(reply?.body).toContain("wrote:");
    expect(reply?.body.length).toBeGreaterThan(reply?.bodyNew?.length ?? 0);
  });

  it("passes deletions through and keeps trashed mail as is", async () => {
    const dir = seeded("2026-10-24T12:00:00-07:00");
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const [first, second] = [...cold.items.keys()];
    if (!first || !second) throw new Error("cold start too small");

    remove(dir, first);
    let page = await syncPage(source, cold.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [first], more: false, kind: "live" });

    relabel(dir, second, { add: ["TRASH"] });
    page = await syncPage(source, page.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [] });
  });

  it("pages incremental history", async () => {
    const dir = seeded("2026-10-20T00:00:00-07:00");
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const ids = deliver(dir, 11);
    const { pages, items } = await syncAll(source, cold.cursor);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.deletions)).toEqual([]);
    expect([...items.keys()]).toEqual(expect.arrayContaining(ids));
  });

  it("lets a deletion win over an add in the same page", async () => {
    const dir = seeded("2026-10-20T00:00:00-07:00");
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const [gone, kept] = deliver(dir, 2);
    remove(dir, gone ?? "");
    const page = await syncPage(source, cold.cursor);
    const upserted = page.upserts.map((i) => i.externalId);
    expect(upserted).toContain(kept);
    expect(upserted).not.toContain(gone);
    expect(page.deletions).toEqual([gone]);
  });

  it("lists mail newer than the watermark less an hour as live pages when history expires, then re-backfills", async () => {
    const dir = seeded();
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const { watermark } = JSON.parse(cold.cursor ?? "").live;
    const [beforeExpiry] = deliverThreads(dir, [freshThread("gap-1", 60_000)]);
    expireHistory(dir);
    const [afterExpiry] = deliverThreads(dir, [freshThread("gap-2")]);

    const recovered = await syncAll(source, cold.cursor);
    const relist = recovered.pages.findIndex((p) => p.kind === "backfill");
    const gap = recovered.pages.slice(0, relist);
    expect(gap.map(({ kind, backfill }) => [kind, backfill])).toEqual(
      gap.map(() => ["live", "running"]),
    );
    expect(gap.flatMap((p) => p.upserts.map((i) => i.externalId))).toEqual(
      expect.arrayContaining([beforeExpiry, afterExpiry]),
    );
    const backfillPages = recovered.pages.slice(relist);
    expect(backfillPages.map(({ kind, backfill }) => [kind, backfill])).toEqual(
      passKinds(backfillPages),
    );
    expect(recovered.pages.flatMap((p) => p.deletions)).toEqual([]);
    expect(recovered.items.size).toBe(34);
    expect(
      readCalls(dir)
        .filter((c) => c.command === "threads list" && String(c.params.q).startsWith("after:"))
        .map((c) => c.params),
    ).toEqual([
      { userId: "me", q: `after:${Math.floor(watermark / 1000) - 3600}`, maxResults: 100 },
    ]);
    expect(JSON.parse(recovered.cursor ?? "")).toMatchObject({ phase: "incremental" });
    const [id] = recovered.items.keys();
    remove(dir, id ?? "");
    const after = await syncPage(source, recovered.cursor);
    expect(after).toMatchObject({ deletions: [id], more: false });
  });

  it("restarts the gap listing when the labels change mid-gap, so a thread skipped under the old labels lands", async () => {
    const dir = seeded();
    const narrow: GwsConfig["labels"] = ["INBOX", "SENT"];
    const cold = await syncAll(sourceFor(dir, narrow), null);
    expireHistory(dir);
    deliverThreads(
      dir,
      Array.from({ length: 10 }, (_, i) => freshThread(`gap-inbox-${i}`, (i + 1) * 60_000)),
    );
    const [promo] = deliverThreads(dir, [
      { ...freshThread("gap-promo"), labels: ["CATEGORY_PROMOTIONS"] },
    ]);

    const first = await syncPage(sourceFor(dir, narrow), cold.cursor);
    expect(first).toMatchObject({ kind: "live", backfill: "running" });
    expect(first.upserts.map((i) => i.externalId)).not.toContain(promo);
    const { after, pageToken } = JSON.parse(first.cursor);
    expect(JSON.parse(first.cursor)).toMatchObject({ phase: "gap", pageToken: expect.any(String) });

    const widened = await syncAll(sourceFor(dir, EVERY_LABEL), first.cursor);
    expect(JSON.parse(widened.pages[0]?.cursor ?? "")).toMatchObject({
      phase: "gap",
      labels: ["CATEGORY_PROMOTIONS", "INBOX", "SENT"],
      after,
    });
    const relist = widened.pages.findIndex((p) => p.kind === "backfill");
    expect(widened.pages.slice(0, relist).every((p) => p.kind === "live")).toBe(true);
    expect(
      widened.pages.slice(0, relist).flatMap((p) => p.upserts.map((i) => i.externalId)),
    ).toContain(promo);
    expect(
      readCalls(dir)
        .filter((c) => c.command === "threads list" && c.params.q === `after:${after}`)
        .map((c) => [c.params.labelIds, c.params.pageToken]),
    ).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [undefined, pageToken],
    ]);
  });

  it("emits a held reply as the first live page of the next pass, before a history 404 relists its thread", async () => {
    const dir = seeded();
    const source = sourceFor(dir, ["INBOX"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Effect.runSync(Clock.currentTimeMillis);
    const [, reply] = deliverThreads(dir, [
      {
        id: "held-reply",
        subject: "Held reply",
        labels: ["INBOX"],
        messages: [
          { at: gmailTime(startedAt - 2 * 3_600_000), from: "priya", to: ["me"], text: "Done?" },
          { at: gmailTime(startedAt - 4 * 60_000), from: "me", to: ["priya"], text: "Yes" },
        ],
      },
    ]);
    const interrupted = await syncPage(source, null);
    expect(interrupted).toMatchObject({ kind: "backfill", more: true });
    expect(interrupted.upserts.map((i) => i.externalId)).not.toContain(reply);
    vi.setSystemTime(startedAt + 10 * 60_000);
    expireHistory(dir);
    const since = readCalls(dir).length;

    const resumed = await syncAll(source, interrupted.cursor);
    expect(resumed.pages[0]).toMatchObject({ kind: "live", backfill: "running" });
    expect(resumed.pages[0]?.upserts.map((i) => i.externalId)).toContain(reply);
    const calls = readCalls(dir).slice(since);
    expect(calls.findIndex((c) => c.command === "threads get")).toBeLessThan(
      calls.findIndex((c) => c.command === "threads list"),
    );
    expect(calls.some((c) => String(c.params.q).startsWith("after:"))).toBe(true);
    expect(JSON.parse(resumed.cursor ?? "")).toMatchObject({ phase: "incremental" });
  });

  it("stores raw without body data or transport headers", async () => {
    const dir = seeded();
    const { items } = await syncAll(sourceFor(dir), null);
    const transport =
      /^(received|arc-|dkim-signature|x-google-|x-received|authentication-results|received-spf|return-path|delivered-to|feedback-id)/i;
    for (const item of items.values()) {
      const raw = decodeMessage(item.raw);
      const full = rawMessage(dir, item);
      expect(partsOf(full.payload).some((p) => p.body?.data !== undefined)).toBe(true);
      expect(full.payload.headers?.some((h) => transport.test(h.name))).toBe(true);
      for (const part of partsOf(raw.payload)) {
        expect(part.body?.data).toBeUndefined();
        expect((part.headers ?? []).filter((h) => transport.test(h.name))).toEqual([]);
      }
      expect(raw.labelIds).toEqual(full.labelIds);
      for (const name of ["from", "to", "cc", "subject", "list-unsubscribe"]) {
        expect(headerValues(raw.payload, name)).toEqual(headerValues(full.payload, name));
      }
      expect(partsOf(raw.payload).length).toBe(partsOf(full.payload).length);
    }
  });

  it("rejects an unknown stream and an invalid cursor", async () => {
    const source = sourceFor(seeded());
    await expect(source.sync("someone@example.com", null, running)).rejects.toThrow(/no stream/);
    await expect(source.sync(ME, "historyId-42", running)).rejects.toThrow();
  });

  it("kills the in-flight gws child and rejects when the signal aborts", async () => {
    const dir = seeded();
    setDelay(dir, { "threads list": 20_000 });
    const running = () =>
      new TextDecoder()
        .decode(Bun.spawnSync(["ps", "-axo", "command="]).stdout)
        .split("\n")
        .filter((line) => line.includes(dir) && line.includes("threads list"));
    const controller = new AbortController();
    const started = performance.now();
    const page = sourceFor(dir).sync(ME, null, controller.signal);
    while (running().length === 0 && performance.now() - started < 10_000) await Bun.sleep(25);
    expect(running()).toHaveLength(1);
    controller.abort();
    await expect(page).rejects.toThrow(/abort/i);
    expect(performance.now() - started).toBeLessThan(20_000);
    expect(running()).toEqual([]);
  });

  it("surfaces gws failures as GwsError", async () => {
    const missing = sourceFor(join(tmpdir(), "weir-gws-no-such-mailbox"));
    const apiError = await missing.streams().catch((e: unknown) => e);
    expect(apiError).toBeInstanceOf(GwsError);
    expect(apiError).toMatchObject({
      exitCode: 3,
      code: 400,
      reason: "validationError",
      message: expect.stringMatching(/cannot read mailbox/),
    });

    const crash = gws.create({
      command: ["sh", "-c", "echo gws exploded >&2; exit 2"],
      backfill: "newer_than:30d",
      labels: EVERY_LABEL,
    });
    const shellError = await crash.sync(ME, null, running).catch((e: unknown) => e);
    expect(shellError).toBeInstanceOf(GwsError);
    expect(shellError).toMatchObject({ exitCode: 2, message: "gws exploded" });
  });
});

describe("gws quota backoff", () => {
  const schedule = [2, 4, 8, 16, 32, 60, 60, 60].map((s) => s * 1000);
  const limitedUntil = Date.parse("2999-01-01T00:00:00Z");
  const recorded = (onSleep: () => void = () => {}) => {
    const delays: number[] = [];
    const sleep: Sleep = async (ms) => {
      delays.push(ms);
      onSleep();
    };
    return { delays, sleep };
  };
  const mailboxSource = (dir: string, sleep: Sleep) =>
    createSource(
      { command: [FAKE_GWS, "--mailbox", dir], backfill: "newer_than:30d", labels: EVERY_LABEL },
      sleep,
    );
  const failing = (error: object, sleep: Sleep) =>
    createSource(
      {
        command: ["sh", "-c", `printf '%s' '${JSON.stringify({ error })}'; exit 1`],
        backfill: "newer_than:30d",
        labels: EVERY_LABEL,
      },
      sleep,
    );

  it("retries a quota error after 2, 4, 8, 16, 32, 60, 60 and 60 s, then fails the page", async () => {
    const dir = seeded();
    setQuota(dir, { until: limitedUntil, methods: ["threads list"] });
    const { delays, sleep } = recorded();
    const error = await mailboxSource(dir, sleep)
      .sync(ME, null, running)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GwsError);
    expect(error).toMatchObject({
      exitCode: 1,
      code: 403,
      reason: "rateLimitExceeded",
      message: expect.stringContaining("Quota exceeded"),
    });
    expect(delays).toEqual(schedule);
    expect(
      readCalls(dir)
        .filter(({ command }) => command === "threads list")
        .map(({ failed }) => failed),
    ).toEqual([...schedule, 0].map(() => true));
  });

  it("finishes the page once the quota window closes", async () => {
    const dir = seeded();
    setQuota(dir, { until: limitedUntil, methods: ["threads get"] });
    const { delays, sleep } = recorded(() => setQuota(dir, undefined));
    const page = decodePage(await mailboxSource(dir, sleep).sync(ME, null, running));
    expect(page).toMatchObject({ kind: "backfill", backfill: "running", more: true });
    expect(page.upserts.length).toBeGreaterThan(0);
    expect(delays.length).toBeGreaterThan(0);
    expect(new Set(delays)).toEqual(new Set([2_000]));
    expect(readCalls(dir).some(({ command, failed }) => command === "threads get" && failed)).toBe(
      true,
    );
  });

  it.each([
    ["HTTP 429", { code: 429, message: "Too many requests" }],
    [
      "403 userRateLimitExceeded",
      { code: 403, reason: "userRateLimitExceeded", message: "User rate limit exceeded" },
    ],
    ["a Quota exceeded message", { code: 500, message: "Quota exceeded for quota metric Queries" }],
  ])("treats %s as a quota error", async (_, error) => {
    const { delays, sleep } = recorded();
    await expect(failing(error, sleep).streams()).rejects.toMatchObject(error);
    await vi.waitFor(() => expect(delays).toHaveLength(2 * schedule.length), { timeout: 5_000 });
    expect(delays.toSorted((a, b) => a - b)).toEqual(
      [...schedule, ...schedule].toSorted((a, b) => a - b),
    );
  });

  it.each([
    ["403 forbidden", { code: 403, reason: "forbidden", message: "Delegation denied" }],
    ["404 notFound", { code: 404, reason: "notFound", message: "Requested entity was not found." }],
  ])("fails at once on %s", async (_, error) => {
    const { delays, sleep } = recorded();
    await expect(failing(error, sleep).streams()).rejects.toMatchObject(error);
    expect(delays).toEqual([]);
  });

  it("rejects at once when the signal aborts during a quota sleep", async () => {
    const dir = seeded();
    setQuota(dir, { until: limitedUntil, methods: ["threads list"] });
    const sleeping = Promise.withResolvers<void>();
    const controller = new AbortController();
    const page = mailboxSource(dir, (ms, signal) => {
      sleeping.resolve();
      return abortableSleep(ms, signal);
    }).sync(ME, null, controller.signal);
    await sleeping.promise;
    const aborted = performance.now();
    controller.abort();
    await expect(page).rejects.toThrow();
    expect(performance.now() - aborted).toBeLessThan(500);
    expect(readCalls(dir).filter(({ command }) => command === "threads list")).toHaveLength(1);
  });
});

describe("gws configSchema", () => {
  const validate = (input: unknown) => gws.configSchema["~standard"].validate(input);

  it("defaults command to gws and labels to INBOX and SENT", async () => {
    expect(await validate({ backfill: "newer_than:30d" })).toEqual({
      value: { command: ["gws"], backfill: "newer_than:30d", labels: ["INBOX", "SENT"] },
    });
  });

  it.each([
    [{}],
    [{ command: [], backfill: "newer_than:30d" }],
    [{ command: "gws", backfill: "newer_than:30d" }],
    [{ backfill: "newer_than:30d", labels: [] }],
    [{ backfill: "newer_than:30d", labels: "INBOX" }],
  ])("rejects %j", async (input) => {
    const result = await validate(input);
    expect(result.issues?.length).toBeGreaterThan(0);
  });
});
