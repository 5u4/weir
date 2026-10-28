import type { RawItem } from "@weir/contract/Source";
import type { Message, MessagePart } from "./gws.ts";
import { htmlBody, htmlBodyNew, plainBody, plainNew } from "./markdown.ts";

const TRANSPORT =
  /^(received|arc-|dkim-signature|x-google-|x-gm-|x-received|authentication-results|received-spf|return-path|delivered-to|x-forwarded|feedback-id|x-ses|x-sg-|x-mailgun|x-feedback)/i;

const trimPart = (part: MessagePart): MessagePart => {
  const { body, headers, parts, ...rest } = part;
  const { data: _, ...size } = body ?? {};
  return {
    ...rest,
    ...(headers ? { headers: headers.filter((h) => !TRANSPORT.test(h.name)) } : {}),
    ...(body ? { body: size } : {}),
    ...(parts ? { parts: parts.map(trimPart) } : {}),
  };
};

const textOf = (part: MessagePart, mimeType: string): string | null => {
  if (part.mimeType === mimeType && part.body?.data !== undefined && !part.filename) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  for (const child of part.parts ?? []) {
    const text = textOf(child, mimeType);
    if (text !== null) return text;
  }
  return null;
};

const FROM = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/;

export const toRawItem = (message: Message, emailAddress: string): RawItem => {
  const header = (name: string) =>
    message.payload.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
  const from = header("from") ?? "";
  const parsed = FROM.exec(from);
  const html = textOf(message.payload, "text/html");
  const plain = textOf(message.payload, "text/plain") ?? "";
  return {
    externalId: message.id,
    threadId: message.threadId,
    containerId: emailAddress,
    containerName: "Gmail",
    occurredAt: new Date(Number(message.internalDate)).toISOString(),
    title: header("subject"),
    from: {
      name: parsed?.[1] ?? "",
      address: (parsed?.[2] ?? from).trim().toLowerCase(),
    },
    body: html === null ? plainBody(plain) : htmlBody.turndown(html).trim(),
    bodyNew: html === null ? plainNew(plain) : htmlBodyNew.turndown(html).trim(),
    link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(emailAddress)}#all/${message.id}`,
    raw: { ...message, payload: trimPart(message.payload) },
  };
};
