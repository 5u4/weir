import { X509Certificate } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Face } from "@weir/contract/Source";
import * as Schema from "effect/Schema";
import { basicConstraints, extensions, logotypeUris } from "./der.ts";

export type Verdict =
  | { readonly ok: true; readonly logo: Uint8Array }
  | { readonly ok: false; readonly reason: string };

const brandIndicatorEku = "1.3.6.1.5.5.7.3.31";
const maxCertificates = 5;
const maxHops = 4;
const maxSvgBytes = 64 * 1024;
const svgDataUri = "data:image/svg+xml;base64,";
const isFace = Schema.is(Face);
const basicConstraintsOid = "2.5.29.19";
const nameConstraintsOid = "2.5.29.30";
const enforcedCritical: Record<string, true> = {
  [basicConstraintsOid]: true,
  "2.5.29.15": true,
  "2.5.29.37": true,
  "2.5.29.17": true,
};

const reject = (reason: string): Verdict => ({ ok: false, reason });

// Bun returns undefined when a certificate has no EKU extension; @types/node says string[].
const usages = (cert: X509Certificate): ReadonlyArray<string> | undefined => cert.keyUsage;

const validAt = (cert: X509Certificate, now: number) =>
  cert.validFromDate.getTime() <= now && now <= cert.validToDate.getTime();

// checkIssued also fails when the issuer's keyUsage lacks keyCertSign.
const issued = (issuer: X509Certificate, cert: X509Certificate) =>
  cert.checkIssued(issuer) && cert.verify(issuer.publicKey);

const constraintBreach = (
  leaf: X509Certificate,
  issuers: ReadonlyArray<X509Certificate>,
): string | null => {
  let below = 0;
  for (const [index, cert] of [leaf, ...issuers].entries()) {
    const found = extensions(cert.raw);
    for (const [oid, extension] of found) {
      if (extension.critical && enforcedCritical[oid] === undefined) {
        return `a certificate on the path has unhandled critical extension ${oid}`;
      }
    }
    if (index === 0) continue;
    if (index < issuers.length && found.has(nameConstraintsOid)) {
      return "an intermediate carries name constraints";
    }
    const basic = found.get(basicConstraintsOid);
    const constraints = basic === undefined ? null : basicConstraints(basic.value);
    if (!constraints?.ca) return "an issuer on the path is not a CA";
    if (constraints.pathLen !== null && below > constraints.pathLen) {
      return "the path is longer than an issuer's path length constraint";
    }
    if (cert.subject !== cert.issuer) below++;
  }
  return null;
};

const logo = (leaf: X509Certificate): Verdict => {
  let uris: ReadonlyArray<string>;
  try {
    uris = logotypeUris(leaf.raw);
  } catch (error) {
    return reject(error instanceof Error ? error.message : String(error));
  }
  const uri = uris.find((candidate) => candidate.startsWith(svgDataUri));
  if (uri === undefined) return reject("leaf has no SVG logotype");
  const packed = Buffer.from(uri.slice(svgDataUri.length), "base64");
  let svg: Uint8Array = packed;
  if (packed[0] === 0x1f && packed[1] === 0x8b) {
    try {
      svg = gunzipSync(packed, { maxOutputLength: maxSvgBytes });
    } catch {
      return reject(`logo is not gzip or inflates past ${maxSvgBytes} bytes`);
    }
  }
  if (svg.length > maxSvgBytes) return reject(`logo is over ${maxSvgBytes} bytes`);
  return isFace({ status: "found", kind: "logo", mime: "image/svg+xml", bytes: svg })
    ? { ok: true, logo: svg }
    : reject("logo is not an SVG image");
};

export const verifiedLogo = (
  pem: string,
  domains: ReadonlyArray<string>,
  roots: ReadonlyArray<X509Certificate>,
  now: number,
): Verdict => {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0 || blocks.length > maxCertificates) {
    return reject(`VMC holds ${blocks.length} certificates`);
  }
  let certificates: ReadonlyArray<X509Certificate>;
  try {
    certificates = blocks.map((block) => new X509Certificate(block));
  } catch {
    return reject("VMC holds a certificate that does not parse");
  }
  const [leaf, ...served] = certificates;
  if (leaf === undefined || leaf.ca) return reject("first certificate is a CA");
  if (!usages(leaf)?.includes(brandIndicatorEku)) return reject("leaf lacks the BIMI EKU");
  const names = (leaf.subjectAltName ?? "")
    .split(", ")
    .flatMap((entry) => (entry.startsWith("DNS:") ? [entry.slice(4).toLowerCase()] : []));
  if (!domains.some((domain) => names.includes(domain.toLowerCase()))) {
    return reject(`leaf SAN names none of ${domains.join(", ")}`);
  }
  const intermediates = served.filter((cert) => {
    const eku = usages(cert);
    return cert.ca && !issued(cert, cert) && (eku === undefined || eku.includes(brandIndicatorEku));
  });
  const issuers: X509Certificate[] = [];
  let current = leaf;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!validAt(current, now)) return reject("a certificate on the path is outside its validity");
    const subject = current;
    const anchor = roots.find((root) => issued(root, subject));
    if (anchor !== undefined) {
      if (!validAt(anchor, now)) return reject("the pinned root is outside its validity");
      let breach: string | null;
      try {
        breach = constraintBreach(leaf, [...issuers, anchor]);
      } catch (error) {
        return reject(error instanceof Error ? error.message : String(error));
      }
      return breach === null ? logo(leaf) : reject(breach);
    }
    const next = intermediates.find((cert) => issued(cert, subject));
    if (next === undefined) return reject("VMC does not chain to a pinned root");
    issuers.push(next);
    current = next;
  }
  return reject(`VMC chain is longer than ${maxHops} hops`);
};
