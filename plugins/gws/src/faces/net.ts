import { lookup, Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { pinnedRoots } from "./roots.ts";

export interface FaceNet {
  fetch(url: string, signal: AbortSignal): Promise<Response>;
  txt(name: string, signal: AbortSignal): Promise<ReadonlyArray<string> | null>;
  readonly roots: ReadonlyArray<string>;
}

const fetchTimeoutMs = 5_000;
const dnsTimeoutMs = 3_000;
const noRecord: Record<string, true> = { ENOTFOUND: true, ENODATA: true };
const maxRedirects = 3;
const redirects: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };

const nonPublic = new BlockList();
for (const [base, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublic.addSubnet(base, bits, "ipv4");
  nonPublic.addSubnet(`::ffff:${base}`, 96 + bits, "ipv6");
  nonPublic.addSubnet(`64:ff9b::${base}`, 96 + bits, "ipv6");
}
for (const [base, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  nonPublic.addSubnet(base, bits, "ipv6");
}

const isPublic = (address: string) => {
  const family = isIP(address);
  return family !== 0 && !nonPublic.check(address, family === 4 ? "ipv4" : "ipv6");
};

const refused = () => new Response(null, { status: 404, statusText: "refused" });

export const publicFetch =
  (
    fetchOnce: (url: string, init: RequestInit) => Promise<Response>,
    resolve: (host: string) => Promise<ReadonlyArray<{ readonly address: string }>>,
  ): FaceNet["fetch"] =>
  async (url, signal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]);
    let target = URL.parse(url);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (target?.protocol !== "https:") return refused();
      const host = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
      const addresses = isIP(host) === 0 ? (await resolve(host)).map((at) => at.address) : [host];
      deadline.throwIfAborted();
      if (addresses.length === 0 || !addresses.every(isPublic)) return refused();
      const response = await fetchOnce(target.href, { redirect: "manual", signal: deadline });
      const location = response.headers.get("location");
      if (redirects[response.status] !== true || location === null) return response;
      await response.body?.cancel();
      target = URL.parse(location, target.href);
    }
    return refused();
  };

export const liveNet: FaceNet = {
  fetch: publicFetch(
    (url, init) => fetch(url, init),
    (host) => lookup(host, { all: true }),
  ),
  txt: async (name, signal) => {
    signal.throwIfAborted();
    const resolver = new Resolver({ timeout: dnsTimeoutMs, tries: 2 });
    const cancel = () => resolver.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && "code" in error && noRecord[String(error.code)]) return null;
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  },
  roots: pinnedRoots.map((root) => root.pem),
};

export const readCapped = async (response: Response, cap: number): Promise<Uint8Array | null> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
