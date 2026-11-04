import { X509Certificate } from "node:crypto";
import type { Face, Faces } from "@weir/contract/Source";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { bimi } from "./bimi.ts";
import { gravatar } from "./gravatar.ts";
import type { FaceNet } from "./net.ts";

const mailbox = /^[^\s@]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;
const concurrency = 4;

const merge = (results: ReadonlyArray<Face>): Face => {
  const found = results.find((result) => result.status === "found");
  if (found !== undefined) return found;
  const errors = results.flatMap((result) => (result.status === "failed" ? [result.error] : []));
  return errors.length === 0
    ? { status: "missing" }
    : { status: "failed", error: errors.join("; ") };
};

export const makeFaces = (net: FaceNet) => {
  const roots = net.roots.map((pem) => new X509Certificate(pem));
  return async (addresses: ReadonlyArray<string>, signal: AbortSignal): Promise<Faces> => {
    const now = Effect.runSync(Clock.currentTimeMillis);
    const attempt = (work: Promise<Face>): Promise<Face> =>
      work.catch((error: unknown) => {
        signal.throwIfAborted();
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      });
    const brands = new Map<string, Promise<Face>>();
    const resolve = async (address: string): Promise<Face> => {
      const domain = mailbox.exec(address)?.[1];
      if (domain === undefined) return { status: "missing" };
      const avatar = await attempt(gravatar(net, address, signal));
      if (avatar.status === "found") return avatar;
      let brand = brands.get(domain);
      if (brand === undefined) {
        brand = attempt(bimi(net, domain, roots, now, signal));
        brands.set(domain, brand);
      }
      return merge([avatar, await brand]);
    };
    const entries: Array<readonly [string, Face]> = [];
    for (let at = 0; at < addresses.length; at += concurrency) {
      const slice = addresses.slice(at, at + concurrency);
      entries.push(
        ...(await Promise.all(
          slice.map(async (address) => [address, await resolve(address)] as const),
        )),
      );
    }
    signal.throwIfAborted();
    return Object.fromEntries(entries);
  };
};
