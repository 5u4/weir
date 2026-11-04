import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { Face, maxFaceBytes, RawItem, SyncPage } from "./Source.ts";

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
  fromVerified: false,
  format: "markdown",
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

  it("decodes an HTML item whose new part the plugin separated", () => {
    const html = { ...item, format: "html", body: "<table></table>", bodyNew: "<table></table>" };
    expect(decodeRawItem(html)).toEqual(html);
  });

  it.each([
    ["without format", { ...item, format: undefined }],
    ["with an unknown format", { ...item, format: "rtf" }],
    ["in HTML without a separated new part", { ...item, format: "html", bodyNew: null }],
  ])("rejects an item %s", (_name, invalid) => {
    expect(() => decodeRawItem(invalid)).toThrow();
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

describe("Face", () => {
  const decodeFace = Schema.decodeUnknownSync(Face, strict);
  const bytes = (...parts: ReadonlyArray<string | ReadonlyArray<number>>) =>
    new Uint8Array(
      parts.flatMap((part) =>
        typeof part === "string" ? [...new TextEncoder().encode(part)] : [...part],
      ),
    );
  const found = (mime: string, body: Uint8Array) => ({
    status: "found",
    kind: "portrait",
    mime,
    bytes: body,
  });

  it.each([
    ["image/png", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])],
    ["image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0])],
    ["image/gif", bytes("GIF89a", [1, 0])],
    ["image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ")],
    ["image/svg+xml", bytes("<svg/>")],
    ["image/svg+xml", bytes([0xef, 0xbb, 0xbf], ' \n<?xml version="1.0"?><svg/>')],
  ])("accepts %s whose bytes start like one", (mime, body) => {
    expect(decodeFace(found(mime, body))).toEqual(found(mime, body));
  });

  it.each([
    ["a PNG labelled JPEG", found("image/jpeg", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))],
    ["HTML labelled SVG", found("image/svg+xml", bytes("<html><script></script></html>"))],
    [
      "SVG text after the first KiB",
      found("image/svg+xml", bytes(`<!--${" ".repeat(1024)}--><svg/>`)),
    ],
    ["an empty image", found("image/png", bytes())],
    [
      "an image over the size limit",
      found("image/svg+xml", bytes("<svg>", " ".repeat(maxFaceBytes))),
    ],
    ["an unknown mime", found("image/bmp", bytes("BM"))],
    ["a failure without its error", { status: "failed" }],
  ])("rejects %s", (_name, face) => {
    expect(() => decodeFace(face)).toThrow();
  });
});
