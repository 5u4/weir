import type { X509Certificate } from "node:crypto";
import type { Face } from "@weir/contract/Source";
import { getDomain } from "tldts";
import { type FaceNet, readCapped } from "./net.ts";
import { verifiedLogo } from "./vmc.ts";

const maxPemBytes = 128 * 1024;
const bimiVersion = /^\s*v\s*=\s*BIMI1\s*(;|$)/;
const dmarcVersion = /^\s*v\s*=\s*DMARC1\s*(;|$)/;
const enforcing: Record<string, true> = { quarantine: true, reject: true };
const policies: Record<string, true> = { none: true, quarantine: true, reject: true };

type Discovery =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "present"; readonly tags: ReadonlyMap<string, string> };

const record = async (
  net: FaceNet,
  name: string,
  version: RegExp,
  signal: AbortSignal,
): Promise<Discovery> => {
  const [only, ...more] = ((await net.txt(name, signal)) ?? []).filter((text) =>
    version.test(text),
  );
  if (only === undefined) return { kind: "absent" };
  if (more.length > 0) return { kind: "invalid" };
  const pairs = only.split(";").flatMap((part): Array<[string, string]> => {
    const at = part.indexOf("=");
    return at < 0 ? [] : [[part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()]];
  });
  const tags = new Map(pairs);
  return tags.size === pairs.length ? { kind: "present", tags } : { kind: "invalid" };
};

const dmarc = async (net: FaceNet, domain: string, signal: AbortSignal): Promise<Discovery> => {
  const found = await record(net, `_dmarc.${domain}`, dmarcVersion, signal);
  if (found.kind !== "present") return found;
  const sp = found.tags.get("sp");
  return policies[found.tags.get("p")?.toLowerCase() ?? ""] === true &&
    (sp === undefined || policies[sp.toLowerCase()] === true)
    ? found
    : { kind: "invalid" };
};

const enforced = async (net: FaceNet, domain: string, org: string, signal: AbortSignal) => {
  const own = await dmarc(net, domain, signal);
  if (own.kind === "invalid") return false;
  const parent = org === domain ? own : await dmarc(net, org, signal);
  if (parent.kind === "invalid") return false;
  const parentTags = parent.kind === "present" ? parent.tags : undefined;
  const tags = own.kind === "present" ? own.tags : parentTags;
  if (tags === undefined) return false;
  const policy = (own.kind === "present" ? tags.get("p") : (tags.get("sp") ?? tags.get("p"))) ?? "";
  return (
    enforcing[policy.toLowerCase()] === true &&
    (tags.get("pct") ?? "100") === "100" &&
    parentTags?.get("p")?.toLowerCase() !== "none"
  );
};

export const bimi = async (
  net: FaceNet,
  domain: string,
  roots: ReadonlyArray<X509Certificate>,
  now: number,
  signal: AbortSignal,
): Promise<Face> => {
  const org = getDomain(domain) ?? domain;
  let recordDomain = domain;
  let assertion = await record(net, `default._bimi.${domain}`, bimiVersion, signal);
  if (assertion.kind === "absent" && org !== domain) {
    recordDomain = org;
    assertion = await record(net, `default._bimi.${org}`, bimiVersion, signal);
  }
  const authority = URL.parse(assertion.kind === "present" ? (assertion.tags.get("a") ?? "") : "");
  if (authority?.protocol !== "https:") return { status: "missing" };
  if (!(await enforced(net, domain, org, signal))) return { status: "missing" };
  const response = await net.fetch(authority.href, signal);
  if (response.status !== 200) {
    await response.body?.cancel();
    return response.status === 429 || response.status >= 500
      ? { status: "failed", error: `${authority.host} answered ${response.status}` }
      : { status: "missing" };
  }
  const pem = await readCapped(response, maxPemBytes);
  if (pem === null) return { status: "missing" };
  const verdict = verifiedLogo(new TextDecoder().decode(pem), [domain, recordDomain], roots, now);
  return verdict.ok
    ? { status: "found", kind: "logo", mime: "image/svg+xml", bytes: verdict.logo }
    : { status: "missing" };
};
