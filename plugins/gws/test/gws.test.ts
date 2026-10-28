import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RawItem, type Source, StreamDescriptor, SyncPage } from "@weir/contract/Source";
import { deliver, expireHistory, relabel, remove, seedMailbox } from "@weir/fixtures";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import scenarios from "../../../packages/fixtures/scenarios.json" with { type: "json" };
import { GwsError, Message, type MessagePart } from "../src/gws.ts";
import { gws } from "../src/index.ts";

const FAKE_GWS = join(import.meta.dirname, "../node_modules/.bin/fake-gws");
const ME = "robin.ellis@example.com";
const strict = { onExcessProperty: "error" } as const;
const decodePage = Schema.decodeUnknownSync(SyncPage, strict);
const decodeStream = Schema.decodeUnknownSync(StreamDescriptor, strict);
const decodeMessage = Schema.decodeUnknownSync(Message);
const decodeMessageJson = Schema.decodeUnknownSync(Schema.fromJsonString(Message));

const dirs: string[] = [];
const seeded = (until?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "weir-gws-"));
  dirs.push(dir);
  seedMailbox(dir, until === undefined ? {} : { until });
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sourceFor = (dir: string): Source =>
  gws.create({ command: [FAKE_GWS, "--mailbox", dir], backfill: "newer_than:30d" });

const syncPage = async (source: Source, cursor: string | null) =>
  decodePage(await source.sync(ME, cursor));

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

const rawMessage = (dir: string, id: string) => {
  const proc = Bun.spawnSync([
    FAKE_GWS,
    "--mailbox",
    dir,
    "gmail",
    "users",
    "messages",
    "get",
    "--params",
    JSON.stringify({ userId: "me", id, format: "full" }),
  ]);
  return decodeMessageJson(proc.stdout.toString());
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
    expect(items.size).toBe(31);
    expect(new Set([...items.values()].map((i) => i.threadId)).size).toBe(14);
    expect(pages.flatMap((p) => p.deletions)).toEqual([]);
    expect(JSON.parse(cursor ?? "")).toMatchObject({ phase: "incremental", pageToken: null });
    const item = [...items.values()][0];
    expect(item?.link).toBe(
      `https://mail.google.com/mail/?authuser=${encodeURIComponent(ME)}#all/${item?.externalId}`,
    );
    expect(item?.containerId).toBe(ME);
    expect(item?.containerName).toBe("Gmail");
  });

  it("returns the scenario text as bodyNew for every message", async () => {
    const people: Record<string, { addr: string }> = scenarios.people;
    const expected = new Map(
      scenarios.threads.flatMap((t) =>
        t.messages.map((m) => [`${Date.parse(m.at)} ${people[m.from]?.addr}`, m.text.trim()]),
      ),
    );
    expect(expected.size).toBe(31);
    const { items } = await syncAll(sourceFor(seeded()), null);
    for (const item of items.values()) {
      const key = `${Date.parse(item.occurredAt)} ${item.from.address}`;
      expect(item.bodyNew?.trim(), key).toBe(expected.get(key));
    }
  });

  it("keeps quoted history and signatures in body", async () => {
    const { items } = await syncAll(sourceFor(seeded()), null);
    const reply = [...items.values()].find(
      (i) => i.title === "Re: Northwind migration: cutover plan and UAT sign-off",
    );
    expect(reply?.body).toContain("wrote:");
    expect(reply?.body.length).toBeGreaterThan(reply?.bodyNew?.length ?? 0);
  });

  it("follows deliveries, deletions and label changes incrementally", async () => {
    const dir = seeded("2026-10-24T12:00:00-07:00");
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const [first, second, third, fourth] = [...cold.items.keys()];
    if (!first || !second || !third || !fourth) throw new Error("cold start too small");

    const [delivered] = deliver(dir);
    let page = await syncPage(source, cold.cursor);
    expect(page.upserts.map((i) => i.externalId)).toEqual([delivered]);
    expect(page.deletions).toEqual([]);

    remove(dir, first);
    page = await syncPage(source, page.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [first], more: false });

    relabel(dir, second, { add: ["TRASH"] });
    page = await syncPage(source, page.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [second] });

    relabel(dir, third, { add: ["SPAM"] });
    page = await syncPage(source, page.cursor);
    expect(page).toMatchObject({ upserts: [], deletions: [third] });

    relabel(dir, fourth, { add: ["STARRED"] });
    page = await syncPage(source, page.cursor);
    expect(page.deletions).toEqual([]);
    expect(page.upserts.map((i) => decodeMessage(i.raw).labelIds)).toEqual([
      expect.arrayContaining(["STARRED"]),
    ]);

    relabel(dir, fourth, { remove: ["STARRED"] });
    page = await syncPage(source, page.cursor);
    expect(page.upserts.map((i) => i.externalId)).toEqual([fourth]);
    expect(page.upserts.map((i) => decodeMessage(i.raw).labelIds)).toEqual([
      expect.not.arrayContaining(["STARRED"]),
    ]);

    const idle = await syncPage(source, page.cursor);
    expect(idle).toEqual({ upserts: [], deletions: [], cursor: page.cursor, more: false });
  });

  it("pages incremental history", async () => {
    const dir = seeded("2026-10-20T00:00:00-07:00");
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const ids = deliver(dir, 11);
    const { pages, items } = await syncAll(source, cold.cursor);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((p) => p.deletions)).toEqual([]);
    expect([...items.keys()].sort()).toEqual([...ids].sort());
  });

  it("lets a deletion win over an add in the same page", async () => {
    const dir = seeded("2026-10-20T00:00:00-07:00");
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    const [gone, kept] = deliver(dir, 2);
    remove(dir, gone ?? "");
    const page = await syncPage(source, cold.cursor);
    expect(page.upserts.map((i) => i.externalId)).toEqual([kept]);
    expect(page.deletions).toEqual([gone]);
  });

  it("re-lists the backfill when history has expired", async () => {
    const dir = seeded();
    const source = sourceFor(dir);
    const cold = await syncAll(source, null);
    expireHistory(dir);
    const recovered = await syncAll(source, cold.cursor);
    expect(recovered.items.size).toBe(31);
    expect(JSON.parse(recovered.cursor ?? "")).toMatchObject({ phase: "incremental" });
    const [id] = recovered.items.keys();
    relabel(dir, id ?? "", { add: ["STARRED"] });
    const after = await syncPage(source, recovered.cursor);
    expect(after.upserts.map((i) => i.externalId)).toEqual([id]);
    expect(after.more).toBe(false);
  });

  it("stores raw without body data or transport headers", async () => {
    const dir = seeded();
    const { items } = await syncAll(sourceFor(dir), null);
    const transport =
      /^(received|arc-|dkim-signature|x-google-|x-received|authentication-results|received-spf|return-path|delivered-to|feedback-id)/i;
    for (const item of items.values()) {
      const raw = decodeMessage(item.raw);
      const full = rawMessage(dir, item.externalId);
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
    await expect(source.sync("someone@example.com", null)).rejects.toThrow(/no stream/);
    await expect(source.sync(ME, "historyId-42")).rejects.toThrow();
  });

  it("surfaces gws failures as GwsError", async () => {
    const missing = gws.create({
      command: [FAKE_GWS, "--mailbox", join(tmpdir(), "weir-gws-no-such-mailbox")],
      backfill: "newer_than:30d",
    });
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
    });
    const shellError = await crash.sync(ME, null).catch((e: unknown) => e);
    expect(shellError).toBeInstanceOf(GwsError);
    expect(shellError).toMatchObject({ exitCode: 2, message: "gws exploded" });
  });
});

describe("gws configSchema", () => {
  const validate = (input: unknown) => gws.configSchema["~standard"].validate(input);

  it("defaults command to gws", async () => {
    expect(await validate({ backfill: "newer_than:30d" })).toEqual({
      value: { command: ["gws"], backfill: "newer_than:30d" },
    });
  });

  it.each([
    [{}],
    [{ command: [], backfill: "newer_than:30d" }],
    [{ command: "gws", backfill: "newer_than:30d" }],
  ])("rejects %j", async (input) => {
    const result = await validate(input);
    expect(result.issues?.length).toBeGreaterThan(0);
  });
});
