import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RawItem, type Source, StreamDescriptor, SyncPage } from "@weir/contract/Source";
import {
  deliver,
  expireHistory,
  FIXTURE_NOW,
  readCalls,
  relabel,
  remove,
  seedMailbox,
  seedThreads,
  setDelay,
} from "@weir/fixtures";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import scenarios from "../../../packages/fixtures/scenarios.json" with { type: "json" };
import { GwsError, Message, type MessagePart } from "../src/gws.ts";
import { type GwsConfig, gws } from "../src/index.ts";

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
const passKinds = (pages: SyncPage[]) => [
  ...pages.slice(0, -2).map(() => ["backfill", "running"]),
  ["backfill", "done"],
  ["live", "done"],
];

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
      pageToken: null,
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
    expect(pages.map((page) => [...new Set(page.upserts.map(subjectOf))])).toEqual([
      subjects.slice(0, 8),
      subjects.slice(8),
      [],
    ]);
    expect(pages.map(({ kind }) => kind)).toEqual(["backfill", "backfill", "live"]);
    expect(pages.map((page) => page.upserts.length)).toEqual([7 * 12 + 150, 3 * 12, 0]);
    expect(pages[0]?.upserts.filter((item) => subjectOf(item) === "Long")).toHaveLength(150);
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
    expect(idle).toEqual({
      upserts: [],
      deletions: [],
      cursor: page.cursor,
      more: false,
      kind: "live",
      backfill: "done",
    });
  });

  it("re-backfills from a fresh listing when the configured labels change", async () => {
    const dir = seeded();
    const inbox = await syncAll(sourceFor(dir, ["INBOX"]), null);
    const widened = await syncAll(sourceFor(dir, ["INBOX", "CATEGORY_PROMOTIONS"]), inbox.cursor);
    expect(widened.pages.map(({ kind, backfill }) => [kind, backfill])).toEqual(
      passKinds(widened.pages),
    );
    expect(widened.items.size).toBe(32);
    expect(JSON.parse(widened.cursor ?? "")).toMatchObject({
      phase: "incremental",
      labels: ["CATEGORY_PROMOTIONS", "INBOX"],
    });
    const reordered = await syncPage(
      sourceFor(dir, ["CATEGORY_PROMOTIONS", "INBOX", "INBOX"]),
      widened.cursor,
    );
    expect(reordered).toMatchObject({ upserts: [], kind: "live", cursor: widened.cursor });
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

  it("re-lists the backfill when history has expired", async () => {
    const dir = seeded();
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    expireHistory(dir);
    const recovered = await syncAll(source, cold.cursor);
    expect(recovered.items.size).toBe(32);
    expect(recovered.pages.map(({ kind, backfill }) => [kind, backfill])).toEqual(
      passKinds(recovered.pages),
    );
    expect(JSON.parse(recovered.cursor ?? "")).toMatchObject({ phase: "incremental" });
    const [id] = recovered.items.keys();
    remove(dir, id ?? "");
    const after = await syncPage(source, recovered.cursor);
    expect(after).toMatchObject({ deletions: [id], more: false });
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
