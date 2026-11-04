import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pinnedRoots } from "./roots.ts";
import { type Verdict, verifiedLogo } from "./vmc.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = (name: string) => read(`../../../../packages/fixtures/faces/${name}.pem`);
const fixtureRoots = [fixture("root"), fixture("constraints-root")].map(
  (pem) => new X509Certificate(pem),
);
const pinned = pinnedRoots.map((root) => new X509Certificate(root.pem));
const now = Date.parse("2026-11-03T12:00:00Z");
const svgText = (verdict: Verdict) =>
  verdict.ok ? new TextDecoder().decode(verdict.logo) : verdict.reason;

describe("verifiedLogo on fixture chains", () => {
  it("returns the logotype SVG of a leaf that chains to a pinned root", () => {
    const verdict = verifiedLogo(
      fixture("northwind.example"),
      ["northwind.example"],
      fixtureRoots,
      now,
    );
    expect(verdict.ok).toBe(true);
    expect(svgText(verdict)).toMatch(/^<svg [^>]*><title>Northwind<\/title>/);
  });

  it("matches the SAN against any of the given domains, ignoring case", () => {
    const verdict = verifiedLogo(
      fixture("northwind.example"),
      ["mail.northwind.example", "NorthWind.Example"],
      fixtureRoots,
      now,
    );
    expect(verdict.ok).toBe(true);
  });

  it("accepts two intermediates under one whose path length allows a CA below it", () => {
    const verdict = verifiedLogo(
      fixture("layered.example"),
      ["layered.example"],
      fixtureRoots,
      now,
    );
    expect(svgText(verdict)).toMatch(/<title>Layered<\/title>/);
  });

  it.each([
    ["a SAN that names another domain", "saltmarsh.example", now, /SAN names none of/],
    ["an expired leaf", "kokoro-ramen.example", now, /outside its validity/],
    [
      "a leaf that is not yet valid",
      "northwind.example",
      Date.parse("2019-06-01T00:00:00Z"),
      /outside its validity/,
    ],
    [
      "a chain to a served root that copies the pinned root's name",
      "northbank.example",
      now,
      /does not chain/,
    ],
    ["a logo that inflates past 64 KiB", "heavy.example", now, /inflates past 65536/],
    [
      "a second CA below an intermediate with pathlen 0",
      "overreach.example",
      now,
      /longer than an issuer's path length constraint/,
    ],
    ["an intermediate with name constraints", "fenced.example", now, /name constraints/],
    [
      "a leaf with an unknown critical extension",
      "stamped.example",
      now,
      /unhandled critical extension 1\.3\.6\.1\.4\.1\.55555\.1/,
    ],
    [
      "an intermediate whose key usage lacks keyCertSign",
      "unsigned.example",
      now,
      /does not chain/,
    ],
  ])("rejects %s", (_, brand, at, reason) => {
    expect(verifiedLogo(fixture(brand), [brand], fixtureRoots, at)).toEqual({
      ok: false,
      reason: expect.stringMatching(reason),
    });
  });

  it("rejects a leaf served without its intermediate", () => {
    const [leaf = ""] = fixture("northwind.example").split(/(?<=-----END CERTIFICATE-----)/);
    expect(verifiedLogo(leaf, ["northwind.example"], fixtureRoots, now)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/does not chain/),
    });
  });

  it("never trusts a served copy of a root that is not pinned", () => {
    const bundle = fixture("northwind.example") + fixture("root");
    expect(verifiedLogo(bundle, ["northwind.example"], pinned, now)).toMatchObject({ ok: false });
  });

  it.each([
    ["no certificate", "not a pem"],
    ["more than five certificates", fixture("northwind.example").repeat(3)],
    [
      "a certificate that does not parse",
      "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
    ],
    ["a CA as the first certificate", fixture("root")],
  ])("rejects a bundle with %s", (_, bundle) => {
    expect(verifiedLogo(bundle, ["northwind.example"], fixtureRoots, now).ok).toBe(false);
  });
});

describe("verifiedLogo on the real paypal.com VMC fetched 2026-11-03", () => {
  const paypal = read("../../test/fixtures/paypal-vmc.pem");

  it("chains to the pinned DigiCert Verified Mark Root CA and yields its SVG logo", () => {
    const verdict = verifiedLogo(paypal, ["paypal.com"], pinned, now);
    expect(verdict.ok).toBe(true);
    expect(svgText(verdict)).toContain("<svg");
  });

  it("is rejected without the pinned roots, for another domain, and after the leaf expires", () => {
    expect(verifiedLogo(paypal, ["paypal.com"], fixtureRoots, now).ok).toBe(false);
    expect(verifiedLogo(paypal, ["paypal.example"], pinned, now).ok).toBe(false);
    const expired = Date.parse("2027-07-13T00:00:00Z");
    expect(verifiedLogo(paypal, ["paypal.com"], pinned, expired).ok).toBe(false);
  });
});
