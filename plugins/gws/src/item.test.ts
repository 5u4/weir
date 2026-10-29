import { describe, expect, it } from "vitest";
import type { Message, MessagePart } from "./gws.ts";
import { toRawItem } from "./item.ts";

const ME = "robin.ellis@example.com";

const text = (
  mimeType: string,
  content: string,
  extra: Partial<MessagePart> = {},
): MessagePart => ({
  mimeType,
  filename: "",
  body: { data: Buffer.from(content).toString("base64url") },
  ...extra,
});

const mixed = (...parts: MessagePart[]): MessagePart => ({
  mimeType: "multipart/mixed",
  filename: "",
  parts,
});

const itemOf = (payload: MessagePart, from = "Ben Ortiz <ben@example.com>") => {
  const message: Message = {
    id: "m1",
    threadId: "t1",
    internalDate: "1761000000000",
    payload: { ...payload, headers: [{ name: "From", value: from }, ...(payload.headers ?? [])] },
  };
  return toRawItem(message, ME);
};

describe("body part selection", () => {
  it("skips an unnamed html part marked as an attachment", () => {
    const item = itemOf(
      mixed(
        text("text/plain", "Ship it."),
        text("text/html", "<p>report</p>", {
          headers: [{ name: "Content-Disposition", value: "attachment" }],
        }),
      ),
    );
    expect(item.body).toBe("Ship it.");
    expect(item.bodyNew).toBe("Ship it.");
  });

  it("skips an unnamed html child inside a named attachment", () => {
    const item = itemOf(
      mixed(text("text/plain", "Ship it."), {
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        parts: [text("text/html", "<p>forwarded</p>")],
      }),
    );
    expect(item.body).toBe("Ship it.");
  });
});

describe("body charset", () => {
  const latin1 = (contentType: string): MessagePart => ({
    mimeType: "text/plain",
    filename: "",
    headers: [{ name: "Content-Type", value: contentType }],
    body: { data: Buffer.from("Un café ?", "latin1").toString("base64url") },
  });

  it.each(['text/plain; charset="ISO-8859-1"', "text/plain; format=flowed; Charset=iso-8859-1"])(
    "decodes %s",
    (contentType) => {
      expect(itemOf(latin1(contentType)).body).toBe("Un café ?");
    },
  );

  it("falls back to UTF-8 for an unknown charset", () => {
    const part = text("text/plain", "Un café ?", {
      headers: [{ name: "Content-Type", value: "text/plain; charset=x-unknown" }],
    });
    expect(itemOf(part).body).toBe("Un café ?");
  });
});

describe("from header", () => {
  it.each([
    ["robin.ellis@example.com", "", "robin.ellis@example.com"],
    ["Ben Ortiz <Ben@Example.com>", "Ben Ortiz", "ben@example.com"],
    ['"Ortiz, Ben" <ben@example.com>', "Ortiz, Ben", "ben@example.com"],
    [
      '"Robin \\"R\\" Ellis" <robin.ellis@example.com>',
      'Robin "R" Ellis',
      "robin.ellis@example.com",
    ],
    ['"Ben <Ops>, Ortiz" <ben@example.com>', "Ben <Ops>, Ortiz", "ben@example.com"],
  ])("parses %s", (header, name, address) => {
    expect(itemOf(text("text/plain", "hi"), header).from).toEqual({ name, address });
  });
});
