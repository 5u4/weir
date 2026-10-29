import { describe, expect, it } from "vitest";
import { gmailMessages } from "../src/gmail.ts";

const htmlOf = (text: string) => {
  const [message] = gmailMessages({
    seenCutoff: "2026-10-20T00:00:00-07:00",
    me: "robin",
    people: {
      robin: { name: "Robin Ellis", addr: "robin.ellis@example.com" },
      ben: { name: "Ben Ortiz", addr: "ben@example.com" },
    },
    chats: [],
    threads: [
      {
        id: "docs-link",
        subject: "Docs",
        labels: ["INBOX"],
        messages: [{ at: "2026-10-21T09:00:00-07:00", from: "ben", to: ["robin"], text }],
      },
    ],
  });
  const part = message?.payload.parts?.find((each) => each.mimeType === "text/html");
  return Buffer.from(part?.body.data ?? "", "base64url").toString("utf8");
};

describe("fake-gws html bodies", () => {
  it("links a bold URL with the URL alone as its href", () => {
    expect(htmlOf("See **https://example.com/docs**")).toContain(
      '<b><a href="https://example.com/docs">https://example.com/docs</a></b>',
    );
  });
});
