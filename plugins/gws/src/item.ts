import { TextDecoder } from "node:util";
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

const headerOf = (part: MessagePart, name: string) =>
  part.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;

const CHARSET = /;\s*charset\s*=\s*"?([^";\s]+)/i;

const decode = (part: MessagePart, data: string) => {
  const bytes = Buffer.from(data, "base64url");
  const charset = CHARSET.exec(headerOf(part, "content-type") ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

const textOf = (part: MessagePart, mimeType: string): string | null => {
  if (part.filename || /^\s*attachment\b/i.test(headerOf(part, "content-disposition") ?? "")) {
    return null;
  }
  if (part.mimeType === mimeType && part.body?.data !== undefined) {
    return decode(part, part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = textOf(child, mimeType);
    if (text !== null) return text;
  }
  return null;
};

const ANGLE_ADDR = /<([^<>]*)>\s*$/;
const QUOTED_STRING = /"((?:[^"\\]|\\.)*)"/g;

const mailbox = (header: string) => {
  const angle = ANGLE_ADDR.exec(header);
  const display = angle ? header.slice(0, angle.index) : "";
  return {
    name: display.replace(QUOTED_STRING, (_, text: string) => text.replace(/\\(.)/g, "$1")).trim(),
    address: (angle?.[1] ?? header).trim().toLowerCase(),
  };
};

export const toRawItem = (message: Message, emailAddress: string): RawItem => {
  const html = textOf(message.payload, "text/html");
  const plain = textOf(message.payload, "text/plain") ?? "";
  return {
    externalId: message.id,
    threadId: message.threadId,
    containerId: emailAddress,
    containerName: "Gmail",
    occurredAt: new Date(Number(message.internalDate)).toISOString(),
    title: headerOf(message.payload, "subject"),
    from: mailbox(headerOf(message.payload, "from") ?? ""),
    body: html === null ? plainBody(plain) : htmlBody(html).trim(),
    bodyNew: html === null ? plainNew(plain) : htmlBodyNew(html).trim(),
    link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(emailAddress)}#all/${message.id}`,
    raw: { ...message, payload: trimPart(message.payload) },
  };
};
