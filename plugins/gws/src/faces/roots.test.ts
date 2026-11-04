import { createHash, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pinnedRoots } from "./roots.ts";

describe("pinnedRoots", () => {
  it.each(pinnedRoots.map((root) => [root.name, root] as const))(
    "%s matches its recorded fingerprint and is a self-signed CA",
    (name, root) => {
      const cert = new X509Certificate(root.pem);
      const digest = createHash("sha256").update(cert.raw).digest("hex").toUpperCase();
      expect(digest.match(/../g)?.join(":")).toBe(root.sha256);
      expect(cert.subject.split("\n")).toContain(`CN=${name}`);
      expect(cert.ca).toBe(true);
      expect(cert.checkIssued(cert) && cert.verify(cert.publicKey)).toBe(true);
      expect(new URL(root.source).protocol).toBe("https:");
    },
  );
});
