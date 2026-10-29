import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { RawItem, SyncPage } from "./Source.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeRawItem = Schema.decodeUnknownSync(RawItem, strict);
const decodeSyncPage = Schema.decodeUnknownSync(SyncPage, strict);

const item = {
  externalId: "msg-1",
  threadId: "thread-1",
  containerId: "INBOX",
  containerName: "Inbox",
  occurredAt: "2026-10-28T09:15:00+02:00",
  title: "Hello",
  from: { name: "Ada", address: "ada@example.com" },
  body: "Hi there",
  bodyNew: null,
  link: null,
  raw: { headers: [] },
};

describe("RawItem", () => {
  it("decodes a valid item", () => {
    expect(decodeRawItem(item)).toEqual(item);
  });

  it("rejects an extra property", () => {
    expect(() => decodeRawItem({ ...item, extra: 1 })).toThrow();
  });

  it("requires nullable keys to be present", () => {
    const { bodyNew: _, ...withoutBodyNew } = item;
    expect(() => decodeRawItem(withoutBodyNew)).toThrow();
  });

  it.each([
    "2026-10-28T09:15:00",
    "2026-10-28",
    "not a date",
    "2026-13-45T09:15:00Z",
    "2026-02-29T09:15:00Z",
    "2026-04-31T09:15:00Z",
    "2026-02-30T09:15:00+02:00",
  ])("rejects occurredAt %s", (occurredAt) => {
    expect(() => decodeRawItem({ ...item, occurredAt })).toThrow();
  });

  it("accepts a leap-day occurredAt", () => {
    expect(decodeRawItem({ ...item, occurredAt: "2024-02-29T23:30:00-05:00" }).occurredAt).toBe(
      "2024-02-29T23:30:00-05:00",
    );
  });

  it("accepts a UTC occurredAt", () => {
    expect(decodeRawItem({ ...item, occurredAt: "2026-10-28T07:15:00.123Z" }).occurredAt).toBe(
      "2026-10-28T07:15:00.123Z",
    );
  });
});

describe("SyncPage", () => {
  const valid = {
    upserts: [item],
    deletions: ["msg-0"],
    cursor: "c1",
    more: false,
    kind: "backfill",
    backfill: "done",
  };

  it("decodes a page of items", () => {
    expect(decodeSyncPage(valid)).toEqual(valid);
  });

  it("rejects a page with an invalid nested item", () => {
    expect(() =>
      decodeSyncPage({ ...valid, upserts: [{ ...item, from: { name: "Ada" } }] }),
    ).toThrow();
  });

  it.each([
    ["without kind", { ...valid, kind: undefined }],
    ["with an unknown kind", { ...valid, kind: "history" }],
    ["without backfill", { ...valid, backfill: undefined }],
    ["with an unknown backfill", { ...valid, backfill: "paused" }],
  ])("rejects a page %s", (_name, page) => {
    expect(() => decodeSyncPage(page)).toThrow();
  });
});

describe("configSchema via Standard Schema", () => {
  const config = Schema.toStandardSchemaV1(Schema.Struct({ account: Schema.String }));

  it("returns the value for valid config", async () => {
    const result = await config["~standard"].validate({ account: "me@example.com" });
    expect(result).toEqual({ value: { account: "me@example.com" } });
  });

  it("returns issues for invalid config", async () => {
    const result = await config["~standard"].validate({ account: 42 });
    expect(result.issues?.length).toBeGreaterThan(0);
  });
});
