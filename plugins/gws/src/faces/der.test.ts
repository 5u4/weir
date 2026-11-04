import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { basicConstraints, extensions, logotypeUris, readTlv } from "./der.ts";

const fixture = (name: string) =>
  new X509Certificate(
    readFileSync(new URL(`../../../../packages/fixtures/faces/${name}.pem`, import.meta.url)),
  );

describe("readTlv", () => {
  it("reads short and long form lengths", () => {
    expect(readTlv(Uint8Array.of(0x04, 0x02, 0xaa, 0xbb), 0, 4)).toEqual({
      tag: 0x04,
      start: 2,
      end: 4,
    });
    const long = new Uint8Array(4 + 300);
    long.set([0x04, 0x82, 0x01, 0x2c]);
    expect(readTlv(long, 0, long.length)).toEqual({ tag: 0x04, start: 4, end: 304 });
  });

  it.each([
    ["a value past its parent", Uint8Array.of(0x04, 0x05, 0xaa), /runs past/],
    ["an indefinite length", Uint8Array.of(0x30, 0x80, 0x00, 0x00), /indefinite/],
    ["a multi-byte tag", Uint8Array.of(0x1f, 0x81, 0x01, 0x00), /multi-byte tag/],
    ["a length of more than four bytes", Uint8Array.of(0x04, 0x85, 1, 1, 1, 1, 1), /length of 5/],
    ["a truncated header", Uint8Array.of(0x04), /truncated header/],
  ])("rejects %s", (_, der, message) => {
    expect(() => readTlv(der, 0, der.length)).toThrow(message);
  });
});

describe("extensions", () => {
  it("reads each extension's OID, critical flag and value", () => {
    const found = extensions(fixture("stamped.example").raw);
    expect([...found].map(([oid, { critical }]) => [oid, critical])).toEqual([
      ["2.5.29.19", true],
      ["2.5.29.15", true],
      ["2.5.29.37", false],
      ["2.5.29.17", false],
      ["2.5.29.35", false],
      ["1.3.6.1.5.5.7.1.12", false],
      ["1.3.6.1.4.1.55555.1", true],
    ]);
    expect([...(found.get("1.3.6.1.4.1.55555.1")?.value ?? [])]).toEqual([0x05, 0x00]);
  });

  it("decodes basicConstraints with and without a path length", () => {
    const value = (name: string) =>
      extensions(fixture(name).raw).get("2.5.29.19")?.value ?? new Uint8Array();
    expect(basicConstraints(value("stamped.example"))).toEqual({ ca: false, pathLen: null });
    expect(basicConstraints(value("constraints-root"))).toEqual({ ca: true, pathLen: null });
    expect(basicConstraints(Uint8Array.of(0x30, 0x06, 0x01, 0x01, 0xff, 0x02, 0x01, 0x03))).toEqual(
      { ca: true, pathLen: 3 },
    );
  });
});

describe("logotypeUris", () => {
  it("finds the SVG data URI inside the logotype extension of a VMC leaf", () => {
    const uris = logotypeUris(fixture("northwind.example").raw);
    expect(uris[0]).toBe("image/svg+xml");
    expect(uris[1]).toMatch(/^data:image\/svg\+xml;base64,H4sI/);
  });

  it("returns nothing for a certificate without the extension", () => {
    expect(logotypeUris(fixture("root").raw)).toEqual([]);
  });

  it("rejects a truncated certificate", () => {
    const raw = fixture("northwind.example").raw;
    expect(() => logotypeUris(raw.subarray(0, raw.length - 10))).toThrow(/DER/);
  });
});
