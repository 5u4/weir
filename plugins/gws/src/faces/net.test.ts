import { describe, expect, it } from "vitest";
import { publicFetch } from "./net.ts";

const running = new AbortController().signal;
const publicAddress = "93.184.216.34";

const net = (
  routes: Record<string, () => Response>,
  hosts: Record<string, ReadonlyArray<string>> = {},
) => {
  const requested: string[] = [];
  const fetch = publicFetch(
    async (url, init) => {
      if (init.redirect !== "manual") throw new Error("redirects must not be followed by fetch");
      requested.push(url);
      const route = routes[url];
      if (route === undefined) throw new Error(`no route for ${url}`);
      return route();
    },
    async (host) => (hosts[host] ?? [publicAddress]).map((address) => ({ address })),
  );
  return { fetch, requested };
};

const ok = () => new Response("ok");
const to = (location: string) => () => new Response(null, { status: 302, headers: { location } });

describe("publicFetch", () => {
  it("follows an https redirect to a public host, resolving a relative Location", async () => {
    const { fetch, requested } = net({
      "https://a.example/start": to("/next?x=1"),
      "https://a.example/next?x=1": to("https://b.example/end"),
      "https://b.example/end": ok,
    });
    const response = await fetch("https://a.example/start", running);
    expect([response.status, await response.text()]).toEqual([200, "ok"]);
    expect(requested).toEqual([
      "https://a.example/start",
      "https://a.example/next?x=1",
      "https://b.example/end",
    ]);
  });

  it("refuses a URL that is not https", async () => {
    const { fetch, requested } = net({ "http://a.example/vmc.pem": ok });
    expect((await fetch("http://a.example/vmc.pem", running)).status).toBe(404);
    expect(requested).toEqual([]);
  });

  it("refuses a redirect that downgrades to http", async () => {
    const { fetch, requested } = net({
      "https://a.example/vmc.pem": to("http://127.0.0.1:7777/admin"),
      "http://127.0.0.1:7777/admin": ok,
    });
    expect((await fetch("https://a.example/vmc.pem", running)).status).toBe(404);
    expect(requested).toEqual(["https://a.example/vmc.pem"]);
  });

  it.each([
    ["an IPv4 loopback", ["127.0.0.1"]],
    ["a private IPv4", ["10.1.2.3"]],
    ["a shared-address IPv4", ["100.64.0.1"]],
    ["a link-local IPv4", ["169.254.169.254"]],
    ["an IPv6 loopback", ["::1"]],
    ["a unique-local IPv6", ["fd12:3456::1"]],
    ["a link-local IPv6", ["fe80::1"]],
    ["an IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["an IPv4-mapped private address in hex", ["::ffff:c0a8:101"]],
    ["a NAT64 private address", ["64:ff9b::a00:1"]],
    ["one private address among public ones", [publicAddress, "192.168.1.1"]],
    ["no address", []],
  ])("refuses a host that resolves to %s", async (_, addresses) => {
    const { fetch, requested } = net(
      { "https://inside.example/": ok },
      {
        "inside.example": addresses,
      },
    );
    expect((await fetch("https://inside.example/", running)).status).toBe(404);
    expect(requested).toEqual([]);
  });

  it.each(["https://127.0.0.1/", "https://[::1]/", "https://[::ffff:7f00:1]/", "https://0x7f.1/"])(
    "refuses the private address literal %s",
    async (url) => {
      const { fetch, requested } = net({ [new URL(url).href]: ok });
      expect((await fetch(url, running)).status).toBe(404);
      expect(requested).toEqual([]);
    },
  );

  it("refuses a redirect to a host with a private address", async () => {
    const { fetch, requested } = net(
      { "https://a.example/vmc.pem": to("https://inside.example/"), "https://inside.example/": ok },
      { "inside.example": ["10.0.0.1"] },
    );
    expect((await fetch("https://a.example/vmc.pem", running)).status).toBe(404);
    expect(requested).toEqual(["https://a.example/vmc.pem"]);
  });

  it("follows three redirects and refuses a fourth", async () => {
    const chain = (hops: number) =>
      Object.fromEntries(
        Array.from({ length: hops + 1 }, (_, at) => [
          `https://a.example/${at}`,
          at === hops ? ok : to(`/${at + 1}`),
        ]),
      );
    expect((await net(chain(3)).fetch("https://a.example/0", running)).status).toBe(200);
    const { fetch, requested } = net(chain(4));
    expect((await fetch("https://a.example/0", running)).status).toBe(404);
    expect(requested).toHaveLength(4);
  });
});
