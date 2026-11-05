import type { Face } from "@weir/contract/Source";
import { fixtureFaceNet } from "@weir/fixtures";
import { describe, expect, it, vi } from "vitest";
import { abortableSleep } from "../src/gws.ts";
import { createSource, type FaceNet } from "../src/index.ts";

const config = {
  command: ["gws"],
  backfill: "newer_than:30d",
  labels: ["INBOX"],
  calendars: [],
} as const;

const facesWith = (net: FaceNet) => {
  const { faces } = createSource(config, abortableSleep, { now: Date.now }, net);
  if (faces === undefined) throw new Error("gws has no faces()");
  return faces;
};

const recorded = (overrides: Partial<FaceNet> = {}) => {
  const fixture = fixtureFaceNet();
  const names: string[] = [];
  const urls: string[] = [];
  const net: FaceNet = {
    roots: fixture.roots,
    fetch: (url, signal) => {
      urls.push(url);
      return (overrides.fetch ?? fixture.fetch)(url, signal);
    },
    txt: (name, signal) => {
      names.push(name);
      return (overrides.txt ?? fixture.txt)(name, signal);
    },
  };
  return { faces: facesWith(net), names, urls, fixture };
};

const running = new AbortController().signal;
const svg = (face: Face | undefined) =>
  face?.status === "found" && face.mime === "image/svg+xml"
    ? new TextDecoder().decode(face.bytes)
    : face;

describe("gws faces", () => {
  it("answers every requested address under its own key", async () => {
    const { faces } = recorded();
    const addresses = ["lisa.chen@example.com", "tomas.silva@example.com", "not-an-address"];
    expect(Object.keys(await faces(addresses, running)).sort()).toEqual([...addresses].sort());
  });

  it("returns a Gravatar image without asking BIMI", async () => {
    const { faces, names } = recorded();
    const { "lisa.chen@example.com": lisa } = await faces(["lisa.chen@example.com"], running);
    expect(svg(lisa)).toMatch(/^<svg /);
    expect(names).toEqual([]);
  });

  it("answers missing for a person with no Gravatar at a domain with no BIMI record", async () => {
    const { faces } = recorded();
    expect(await faces(["tomas.silva@example.com"], running)).toEqual({
      "tomas.silva@example.com": { status: "missing" },
    });
  });

  it("answers missing without network for something that is not local@domain", async () => {
    const { faces, names, urls } = recorded();
    expect(await faces(["robin", "a@b", "two@at@example.com"], running)).toEqual({
      robin: { status: "missing" },
      "a@b": { status: "missing" },
      "two@at@example.com": { status: "missing" },
    });
    expect([...names, ...urls]).toEqual([]);
  });

  it("returns the brand logo from a validated VMC and never fetches the l= URL", async () => {
    const { faces, urls } = recorded();
    const { "rachel.gomez@northwind.example": rachel } = await faces(
      ["rachel.gomez@northwind.example"],
      running,
    );
    expect(svg(rachel)).toContain("<title>Northwind</title>");
    expect(urls.filter((url) => url.endsWith("logo.svg"))).toEqual([]);
  });

  it("falls back to the organizational domain's BIMI record for a subdomain sender", async () => {
    const { faces, names } = recorded();
    const { "billing@mail.northwind.example": billing } = await faces(
      ["billing@mail.northwind.example"],
      running,
    );
    expect(svg(billing)).toContain("<title>Northwind</title>");
    expect(names).toContain("default._bimi.mail.northwind.example");
    expect(names).toContain("default._bimi.northwind.example");
  });

  it("answers missing when DMARC does not enforce, without fetching the VMC", async () => {
    const { faces, urls } = recorded();
    expect(await faces(["deals@ridgeway.example"], running)).toEqual({
      "deals@ridgeway.example": { status: "missing" },
    });
    expect(urls.filter((url) => url.includes("ridgeway"))).toEqual([]);
  });

  it.each([
    ["a VMC for another domain", "offers@saltmarsh.example"],
    ["an expired VMC", "hello@kokoro-ramen.example"],
    ["a VMC from an untrusted root", "alerts@northbank.example"],
    ["a VMC whose logo inflates past the cap", "news@heavy.example"],
  ])("answers missing for %s", async (_, address) => {
    const { faces } = recorded();
    expect(await faces([address], running)).toEqual({ [address]: { status: "missing" } });
  });

  it.each([
    ["v=DMARC1; p=quarantine; pct=50", { status: "missing" }],
    ["v=DMARC1; p=reject; pct=100", { status: "found" }],
  ])("applies the DMARC pct rule to %s", async (dmarc, expected) => {
    const { faces } = recorded({
      txt: (name, signal) =>
        name === "_dmarc.northwind.example"
          ? Promise.resolve([dmarc])
          : fixtureFaceNet().txt(name, signal),
    });
    const answer = await faces(["omar.haddad@northwind.example"], running);
    expect(answer["omar.haddad@northwind.example"]).toMatchObject(expected);
  });

  it.each([
    "v=DMARC1; p=none; p=reject",
    "v=DMARC1; p=reject; pct=50; pct=100",
    "v=DMARC1; p=reject; P=reject",
  ])("answers missing for a DMARC record with a repeated tag: %s", async (dmarc) => {
    const { faces } = recorded({
      txt: (name, signal) =>
        name === "_dmarc.northwind.example"
          ? Promise.resolve([dmarc])
          : fixtureFaceNet().txt(name, signal),
    });
    expect(await faces(["omar.haddad@northwind.example"], running)).toEqual({
      "omar.haddad@northwind.example": { status: "missing" },
    });
  });

  it("answers missing when the organizational domain publishes p=none", async () => {
    const { faces } = recorded({
      txt: (name, signal) => {
        if (name === "_dmarc.northwind.example") return Promise.resolve(["v=DMARC1; p=none"]);
        if (name === "_dmarc.mail.northwind.example")
          return Promise.resolve(["v=DMARC1; p=reject"]);
        return fixtureFaceNet().txt(name, signal);
      },
    });
    expect(await faces(["billing@mail.northwind.example"], running)).toEqual({
      "billing@mail.northwind.example": { status: "missing" },
    });
  });

  it("answers missing when the organizational domain's DMARC record is invalid", async () => {
    const { faces } = recorded({
      txt: (name, signal) => {
        if (name === "_dmarc.northwind.example")
          return Promise.resolve(["v=DMARC1; p=none; p=reject"]);
        if (name === "_dmarc.mail.northwind.example")
          return Promise.resolve(["v=DMARC1; p=reject"]);
        return fixtureFaceNet().txt(name, signal);
      },
    });
    expect(await faces(["billing@mail.northwind.example"], running)).toEqual({
      "billing@mail.northwind.example": { status: "missing" },
    });
  });

  it.each([
    ["v=DMARC1; sp=reject", []],
    ["v=DMARC1; p=invalid; sp=reject", []],
    ["v=DMARC1; p=reject; sp=bogus", []],
    ["v=DMARC1; p=reject", ["v=DMARC1; p=bogus"]],
  ])(
    "answers missing when the organizational record is %s and the subdomain publishes %j",
    async (org, own) => {
      const { faces } = recorded({
        txt: (name, signal) => {
          if (name === "_dmarc.northwind.example") return Promise.resolve([org]);
          if (name === "_dmarc.mail.northwind.example") return Promise.resolve(own);
          return fixtureFaceNet().txt(name, signal);
        },
      });
      expect(await faces(["billing@mail.northwind.example"], running)).toEqual({
        "billing@mail.northwind.example": { status: "missing" },
      });
    },
  );

  it("answers found for a subdomain covered by an organizational sp=reject", async () => {
    const { faces } = recorded({
      txt: (name, signal) => {
        if (name === "_dmarc.northwind.example")
          return Promise.resolve(["v=DMARC1; p=quarantine; sp=reject"]);
        if (name === "_dmarc.mail.northwind.example") return Promise.resolve([]);
        return fixtureFaceNet().txt(name, signal);
      },
    });
    expect(await faces(["billing@mail.northwind.example"], running)).toMatchObject({
      "billing@mail.northwind.example": { status: "found" },
    });
  });

  it("answers missing when a domain publishes two BIMI records", async () => {
    const record = "v=BIMI1; a=https://northwind.example/vmc.pem";
    const { faces } = recorded({
      txt: (name, signal) =>
        name === "default._bimi.northwind.example"
          ? Promise.resolve([record, record])
          : fixtureFaceNet().txt(name, signal),
    });
    expect(await faces(["omar.haddad@northwind.example"], running)).toEqual({
      "omar.haddad@northwind.example": { status: "missing" },
    });
  });

  it.each([
    [
      "two DMARC records",
      "_dmarc.mail.northwind.example",
      ["v=DMARC1; p=reject", "v=DMARC1; p=reject"],
    ],
    [
      "a DMARC record without p=",
      "_dmarc.mail.northwind.example",
      ["v=DMARC1; rua=mailto:d@northwind.example"],
    ],
    [
      "two BIMI records",
      "default._bimi.mail.northwind.example",
      [
        "v=BIMI1; a=https://northwind.example/vmc.pem",
        "v=BIMI1; a=https://northwind.example/vmc.pem",
      ],
    ],
  ])(
    "answers missing when a subdomain publishes %s instead of using its parent's",
    async (_, at, answer) => {
      const { faces } = recorded({
        txt: (name, signal) =>
          name === at ? Promise.resolve(answer) : fixtureFaceNet().txt(name, signal),
      });
      expect(await faces(["billing@mail.northwind.example"], running)).toEqual({
        "billing@mail.northwind.example": { status: "missing" },
      });
    },
  );

  it("answers failed when DNS fails", async () => {
    const { faces } = recorded();
    expect(await faces(["notifications@github.example"], running)).toEqual({
      "notifications@github.example": {
        status: "failed",
        error: expect.stringContaining("ESERVFAIL"),
      },
    });
  });

  describe("merge rule", () => {
    const gravatarDown = (fixture: FaceNet): Pick<FaceNet, "fetch"> => ({
      fetch: (url, signal) =>
        url.startsWith("https://gravatar.com/")
          ? Promise.resolve(new Response("busy", { status: 503 }))
          : fixture.fetch(url, signal),
    });

    it("lets a found brand logo win over a failed Gravatar", async () => {
      const { faces } = recorded(gravatarDown(fixtureFaceNet()));
      const answer = await faces(["rachel.gomez@northwind.example"], running);
      expect(svg(answer["rachel.gomez@northwind.example"])).toContain("Northwind");
    });

    it("answers failed when Gravatar failed and BIMI is missing", async () => {
      const { faces } = recorded(gravatarDown(fixtureFaceNet()));
      expect(await faces(["tomas.silva@example.com"], running)).toEqual({
        "tomas.silva@example.com": { status: "failed", error: "gravatar answered 503" },
      });
    });

    it("answers failed when Gravatar is missing and BIMI failed", async () => {
      const { faces } = recorded();
      const answer = await faces(["review_requested@noreply.github.example"], running);
      expect(answer["review_requested@noreply.github.example"]?.status).toBe("failed");
    });
  });

  it.each([
    ["a content type that is not an image", "text/html", "<svg/>", /gravatar sent text\/html/],
    ["bytes that do not match the content type", "image/png", "<svg/>", /not image\/png/],
    ["an image over 256 KiB", "image/png", "x".repeat(256 * 1024 + 1), /over 262144 bytes/],
  ])("answers failed for a Gravatar reply with %s", async (_, type, body, error) => {
    const { faces } = recorded({
      fetch: async () => new Response(body, { headers: { "content-type": type } }),
    });
    expect(await faces(["tomas.silva@example.com"], running)).toEqual({
      "tomas.silva@example.com": { status: "failed", error: expect.stringMatching(error) },
    });
  });

  it("resolves BIMI once per domain within a call", async () => {
    const { faces, names, urls } = recorded();
    const answer = await faces(
      [
        "rachel.gomez@northwind.example",
        "omar.haddad@northwind.example",
        "sales@northwind.example",
        "ops@northwind.example",
        "support@northwind.example",
      ],
      running,
    );
    expect(Object.values(answer).map((face) => face.status)).toEqual(Array(5).fill("found"));
    expect(names.filter((name) => name === "default._bimi.northwind.example")).toHaveLength(1);
    expect(urls.filter((url) => url === "https://northwind.example/vmc.pem")).toHaveLength(1);
  });

  it("rejects the whole call and cancels in-flight lookups when the signal aborts", async () => {
    const waiting: AbortSignal[] = [];
    const { faces } = recorded({
      txt: (_, signal) => {
        const { promise, reject } = Promise.withResolvers<ReadonlyArray<string> | null>();
        waiting.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      },
    });
    const controller = new AbortController();
    const call = faces(
      ["rachel.gomez@northwind.example", "lisa.chen@example.com"],
      controller.signal,
    );
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    controller.abort(new Error("reload"));
    await expect(call).rejects.toThrow("reload");
    expect(waiting[0]?.aborted).toBe(true);
  });

  it("rejects at once when the signal is already aborted", async () => {
    const { faces } = recorded();
    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    await expect(faces(["lisa.chen@example.com"], controller.signal)).rejects.toThrow("shutdown");
  });
});
