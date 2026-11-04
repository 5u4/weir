import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { scenarios } from "./scenarios.ts";

const facePeople = ["me", "lisa", "ben", "dan"] as const;

const faceBrands = {
  "northwind.example": "v=DMARC1; p=reject",
  "ridgeway.example": "v=DMARC1; p=none",
  "saltmarsh.example": "v=DMARC1; p=quarantine",
  "kokoro-ramen.example": "v=DMARC1; p=reject",
  "northbank.example": "v=DMARC1; p=reject",
  "heavy.example": "v=DMARC1; p=reject",
} as const;

const unreachable = "github.example";

const faceFile = (name: string) =>
  readFileSync(new URL(`../faces/${name}.pem`, import.meta.url), "utf8");

const portrait = (address: string): Uint8Array => {
  const [a = 0, b = 0, c = 0] = createHash("sha256").update(address).digest();
  const hue = Math.round((a * 360) / 256);
  const skin = `hsl(${hue} 35% 38%)`;
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(${hue} 45% 84%)"/><circle cx="48" cy="${36 + (b % 6)}" r="${16 + (c % 4)}" fill="${skin}"/><path d="M14 96c4-22 18-32 34-32s30 10 34 32z" fill="${skin}"/></svg>`,
  );
};

export const fixtureFaceNet = () => {
  const portraits = new Map(
    facePeople.map((id) => {
      const person = scenarios.people[id];
      if (person === undefined) throw new Error(`scenarios has no person ${id}`);
      return [createHash("sha256").update(person.addr).digest("hex"), portrait(person.addr)];
    }),
  );
  const brands = Object.entries(faceBrands);
  const records = new Map<string, ReadonlyArray<string>>(
    brands.flatMap(([brand, dmarc]) => [
      [
        `default._bimi.${brand}`,
        [`v=BIMI1; l=https://${brand}/logo.svg; a=https://${brand}/vmc.pem`],
      ],
      [`_dmarc.${brand}`, [dmarc]],
    ]),
  );
  const chains = new Map(brands.map(([brand]) => [`https://${brand}/vmc.pem`, faceFile(brand)]));
  return {
    fetch: async (url: string, signal: AbortSignal): Promise<Response> => {
      signal.throwIfAborted();
      const gravatar = /^https:\/\/gravatar\.com\/avatar\/([0-9a-f]{64})\?d=404&s=96$/.exec(url);
      if (gravatar !== null) {
        const image = portraits.get(gravatar[1] ?? "");
        return image === undefined
          ? new Response("Not Found", { status: 404, headers: { "content-type": "text/html" } })
          : new Response(image, { headers: { "content-type": "image/svg+xml" } });
      }
      const chain = chains.get(url);
      if (chain === undefined) throw new Error(`fixtureFaceNet has no route for ${url}`);
      return new Response(chain, { headers: { "content-type": "application/x-pem-file" } });
    },
    txt: async (name: string, signal: AbortSignal): Promise<ReadonlyArray<string> | null> => {
      signal.throwIfAborted();
      if (name === unreachable || name.endsWith(`.${unreachable}`)) {
        throw Object.assign(new Error(`queryTxt ESERVFAIL ${name}`), { code: "ESERVFAIL" });
      }
      const answer = records.get(name);
      if (answer !== undefined) return answer;
      if (name.endsWith(".example") || name === "example.com" || name.endsWith(".example.com")) {
        return null;
      }
      throw new Error(`fixtureFaceNet has no DNS name ${name}`);
    },
    roots: [faceFile("root")],
  };
};
