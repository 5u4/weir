import * as dns from "node:dns";
import { afterEach, expect } from "vitest";

const hits: string[] = [];
const loopback: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (loopback[url.hostname]) return realFetch(input, init);
  if (!url.hostname.endsWith(".test")) hits.push(`fetch ${url.host}`);
  return Promise.reject(new Error(`network tripwire: fetch ${url.host}`));
}, realFetch);

const refuse = (name: string) => {
  hits.push(`dns ${name}`);
  return Promise.reject(new Error(`network tripwire: dns ${name}`));
};
dns.promises.Resolver.prototype.resolveTxt = refuse;
dns.promises.resolveTxt = refuse;
dns.promises.lookup = refuse;

afterEach(() => {
  expect(hits.splice(0), "a test reached the real network; pass fixtureFaceNet()").toEqual([]);
});
