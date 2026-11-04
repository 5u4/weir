#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const out = join(import.meta.dirname, "../../faces");
const work = mkdtempSync(join(tmpdir(), "weir-vmc-"));

const validFrom = "20200101000000Z";
const validTo = "20991231235959Z";
const bimiEku = "1.3.6.1.5.5.7.3.31";
const logotypeOid = "1.3.6.1.5.5.7.1.12";

let serial = 1;
const openssl = (...args: string[]) => {
  execFileSync("openssl", args, { cwd: work, stdio: ["ignore", "ignore", "inherit"] });
};
const file = (name: string) => join(work, name);

const length = (n: number): Uint8Array => {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
};
const tlv = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const value = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.of(tag), length(value.length), value]);
};
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const ia5 = (text: string) => tlv(0x16, Buffer.from(text, "ascii"));
const sha256Oid = Uint8Array.of(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01);

const logotype = (svg: string): Uint8Array => {
  const gz = gzipSync(svg);
  const uri = `data:image/svg+xml;base64,${gz.toString("base64")}`;
  const hash = seq(seq(tlv(0x06, sha256Oid)), tlv(0x04, createHash("sha256").update(gz).digest()));
  const details = seq(ia5("image/svg+xml"), seq(hash), seq(ia5(uri)));
  return seq(tlv(0xa2, tlv(0xa0, seq(seq(details)))));
};

const lettermark = (title: string, fill: string, path: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>${title}</title><rect width="64" height="64" fill="${fill}"/><path d="${path}" fill="#ffffff"/></svg>`;
const letterN = "M18 46V18h6l16 19V18h6v28h-6L24 27v19z";
const letterR = "M20 46V18h14a9 9 0 0 1 2 17.8L45 46h-7l-8-10h-4v10zm6-16h8a3 3 0 0 0 0-6h-8z";
const letterS =
  "M44 22c-3-3-7-4-12-4-7 0-12 3-12 8 0 11 18 6 18 13 0 2-3 3-6 3-4 0-8-1-11-4l-3 5c4 3 9 5 14 5 8 0 13-4 13-9 0-11-18-7-18-13 0-2 2-3 5-3s6 1 9 3z";
const letterK = "M20 46V18h6v12l11-12h8L33 31l13 15h-8l-9-11-3 3v8z";
const heavy = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><desc>${"x".repeat(96 * 1024)}</desc><rect width="64" height="64"/></svg>`;

const key = (name: string) => {
  openssl(
    "genpkey",
    "-algorithm",
    "EC",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-out",
    file(`${name}.key`),
  );
};

const root = (name: string, subject: string) => {
  key(name);
  openssl(
    "req",
    "-x509",
    "-key",
    file(`${name}.key`),
    "-subj",
    subject,
    "-not_before",
    validFrom,
    "-not_after",
    validTo,
    "-set_serial",
    String(serial++),
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-addext",
    "subjectKeyIdentifier=hash",
    "-out",
    file(`${name}.pem`),
  );
};

const issue = (
  name: string,
  issuer: string,
  subject: string,
  extensions: ReadonlyArray<string>,
  window: { readonly from: string; readonly to: string } = { from: validFrom, to: validTo },
) => {
  key(name);
  openssl(
    "req",
    "-new",
    "-key",
    file(`${name}.key`),
    "-subj",
    subject,
    "-out",
    file(`${name}.csr`),
  );
  writeFileSync(file(`${name}.cnf`), `[v3]\n${extensions.join("\n")}\n`);
  openssl(
    "x509",
    "-req",
    "-in",
    file(`${name}.csr`),
    "-CA",
    file(`${issuer}.pem`),
    "-CAkey",
    file(`${issuer}.key`),
    "-not_before",
    window.from,
    "-not_after",
    window.to,
    "-set_serial",
    String(serial++),
    "-extfile",
    file(`${name}.cnf`),
    "-extensions",
    "v3",
    "-out",
    file(`${name}.pem`),
  );
};

const leaf = (
  name: string,
  issuer: string,
  san: string,
  svg: string,
  options: {
    readonly window?: { readonly from: string; readonly to: string };
    readonly extra?: ReadonlyArray<string>;
  } = {},
) =>
  issue(
    name,
    issuer,
    `/O=${name}/CN=${name}`,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      `extendedKeyUsage=${bimiEku}`,
      `subjectAltName=DNS:${san}`,
      "authorityKeyIdentifier=keyid",
      `${logotypeOid}=DER:${Buffer.from(logotype(svg)).toString("hex")}`,
      ...(options.extra ?? []),
    ],
    options.window,
  );

const intermediate = (
  name: string,
  issuer: string,
  constraints: { readonly basic: string; readonly usage?: string; readonly extra?: string },
) =>
  issue(name, issuer, `/O=Weir Fixtures/CN=Weir Fixture ${name}`, [
    `basicConstraints=critical,${constraints.basic}`,
    `keyUsage=critical,${constraints.usage ?? "keyCertSign,cRLSign"}`,
    `extendedKeyUsage=${bimiEku}`,
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid",
    ...(constraints.extra === undefined ? [] : [constraints.extra]),
  ]);

root("root", "/O=Weir Fixtures/CN=Weir Fixture Mark Root");
issue("intermediate", "root", "/O=Weir Fixtures/CN=Weir Fixture Mark Intermediate", [
  "basicConstraints=critical,CA:TRUE,pathlen:0",
  "keyUsage=critical,keyCertSign,cRLSign",
  `extendedKeyUsage=${bimiEku}`,
  "subjectKeyIdentifier=hash",
  "authorityKeyIdentifier=keyid",
]);
root("rogue", "/O=Weir Fixtures/CN=Weir Fixture Mark Root");

leaf(
  "northwind.example",
  "intermediate",
  "northwind.example",
  lettermark("Northwind", "#1d4ed8", letterN),
);
leaf(
  "ridgeway.example",
  "intermediate",
  "ridgeway.example",
  lettermark("Ridgeway", "#15803d", letterR),
);
leaf(
  "saltmarsh.example",
  "intermediate",
  "saltmarsh-travel.example",
  lettermark("Saltmarsh", "#0e7490", letterS),
);
leaf(
  "kokoro-ramen.example",
  "intermediate",
  "kokoro-ramen.example",
  lettermark("Kokoro", "#b91c1c", letterK),
  { window: { from: "20190101000000Z", to: "20200101000000Z" } },
);
leaf(
  "northbank.example",
  "rogue",
  "northbank.example",
  lettermark("Northbank", "#334155", letterN),
);
leaf("heavy.example", "intermediate", "heavy.example", heavy);

root("constraints-root", "/O=Weir Fixtures/CN=Weir Fixture Constraints Root");
intermediate("tier-one", "constraints-root", { basic: "CA:TRUE,pathlen:1" });
intermediate("tier-two", "tier-one", { basic: "CA:TRUE,pathlen:0" });
intermediate("capped", "constraints-root", { basic: "CA:TRUE,pathlen:0" });
intermediate("under-cap", "capped", { basic: "CA:TRUE" });
intermediate("fenced", "constraints-root", {
  basic: "CA:TRUE,pathlen:0",
  extra: "nameConstraints=excluded;DNS:fenced.example",
});
intermediate("plain", "constraints-root", { basic: "CA:TRUE,pathlen:0" });
intermediate("no-cert-sign", "constraints-root", {
  basic: "CA:TRUE,pathlen:0",
  usage: "digitalSignature,cRLSign",
});

leaf("layered.example", "tier-two", "layered.example", lettermark("Layered", "#6d28d9", letterN));
leaf(
  "overreach.example",
  "under-cap",
  "overreach.example",
  lettermark("Overreach", "#a16207", letterR),
);
leaf("fenced.example", "fenced", "fenced.example", lettermark("Fenced", "#be185d", letterS));
leaf("stamped.example", "plain", "stamped.example", lettermark("Stamped", "#0f766e", letterK), {
  extra: ["1.3.6.1.4.1.55555.1=critical,DER:05:00"],
});
leaf(
  "unsigned.example",
  "no-cert-sign",
  "unsigned.example",
  lettermark("Unsigned", "#4d7c0f", letterN),
);

const bundles: Record<string, ReadonlyArray<string>> = {
  root: ["root"],
  "northwind.example": ["northwind.example", "intermediate"],
  "ridgeway.example": ["ridgeway.example", "intermediate"],
  "saltmarsh.example": ["saltmarsh.example", "intermediate"],
  "kokoro-ramen.example": ["kokoro-ramen.example", "intermediate"],
  "heavy.example": ["heavy.example", "intermediate"],
  "northbank.example": ["northbank.example", "rogue"],
  "constraints-root": ["constraints-root"],
  "layered.example": ["layered.example", "tier-two", "tier-one"],
  "overreach.example": ["overreach.example", "under-cap", "capped"],
  "fenced.example": ["fenced.example", "fenced"],
  "stamped.example": ["stamped.example", "plain"],
  "unsigned.example": ["unsigned.example", "no-cert-sign"],
};

const pem = (name: string) => readFileSync(file(`${name}.pem`), "utf8");
mkdirSync(out, { recursive: true });
for (const [bundle, chain] of Object.entries(bundles)) {
  writeFileSync(join(out, `${bundle}.pem`), chain.map(pem).join(""));
}
rmSync(work, { recursive: true });
