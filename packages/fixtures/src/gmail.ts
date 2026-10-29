import type { Person, Scenarios, Thread, ThreadMessage } from "./scenarios.ts";

export type Header = { name: string; value: string };
export type MessagePartBody = { size: number; data?: string };
export type MessagePart = {
  partId: string;
  mimeType: string;
  filename: string;
  headers: Header[];
  body: MessagePartBody;
  parts?: MessagePart[];
};
export type Message = {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: MessagePart;
  sizeEstimate: number;
  historyId: string;
  internalDate: string;
};
export type GeneratedMessage = Omit<Message, "historyId">;

const PLAIN_ONLY_THREAD = "note-to-self";
const MX = "mx.google.example";
const WEEKDAYS = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

const sha1 = (input: string) => new Bun.CryptoHasher("sha1").update(input).digest("hex");
const b64 = (input: string, length: number) =>
  new Bun.CryptoHasher("sha256").update(input).digest("base64").slice(0, length);
const octet = (input: string) => (Number.parseInt(sha1(input).slice(0, 4), 16) % 254) + 1;

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offset: string;
  ms: number;
};

const wallClock = (at: string): WallClock => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}):(\d{2})$/.exec(at);
  if (!m) throw new Error(`scenario time without an explicit offset: ${at}`);
  const n = (i: number) => Number(m[i] ?? 0);
  return {
    year: n(1),
    month: n(2),
    day: n(3),
    hour: n(4),
    minute: n(5),
    second: n(6),
    offset: `${m[7]}${m[8]}`,
    ms: Date.parse(at),
  };
};

const pad = (n: number) => String(n).padStart(2, "0");
const weekday = (c: WallClock) =>
  WEEKDAYS[Math.floor(Date.UTC(c.year, c.month - 1, c.day) / DAY_MS) % 7];

const rfc2822 = (c: WallClock) =>
  `${weekday(c)}, ${c.day} ${MONTHS[c.month - 1]} ${c.year} ${pad(c.hour)}:${pad(c.minute)}:${pad(c.second)} ${c.offset}`;

const attribution = (c: WallClock, sender: Person) => {
  const hour12 = c.hour % 12 || 12;
  const meridiem = c.hour < 12 ? "AM" : "PM";
  return `On ${weekday(c)}, ${MONTHS[c.month - 1]} ${c.day}, ${c.year} at ${hour12}:${pad(c.minute)} ${meridiem} ${sender.name} <${sender.addr}> wrote:`;
};

const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const textHtml = (text: string) =>
  text
    .split("\n\n")
    .map((p) => {
      const linked = escapeHtml(p)
        .replace(/https?:\/\/[^\s<>()"]+/g, (url) => `<a href="${url}">${url}</a>`)
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      return `<p>${linked.replaceAll("\n", "<br>")}</p>`;
    })
    .join("");

const messageHtml = (m: ThreadMessage) => m.html ?? `<div dir="ltr">${textHtml(m.text)}</div>`;

const signatureHtml = (signature: string) =>
  `<div class="gmail_signature">${escapeHtml(signature).replaceAll("\n", "<br>")}</div>`;

const signed = (text: string, sender: Person) =>
  sender.signature ? `${text}\n\n-- \n${sender.signature}` : text;

const leaf = (
  partId: string,
  mimeType: string,
  content: string,
  headers: Header[],
): MessagePart => ({
  partId,
  mimeType,
  filename: "",
  headers,
  body: {
    size: Buffer.byteLength(content, "utf8"),
    data: Buffer.from(content).toString("base64url"),
  },
});
const contentType = (mimeType: string): Header => ({
  name: "Content-Type",
  value: `${mimeType}; charset="UTF-8"`,
});

const snippetOf = (text: string) =>
  escapeHtml(
    text
      .replace(/\]\([^)]*\)|[#*_`>[\]]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200),
  ).replaceAll("'", "&#39;");

const domainOf = (addr: string) => addr.slice(addr.indexOf("@") + 1);

const transportHeaders = (
  key: string,
  sender: Person,
  recipient: string,
  clock: WallClock,
  bulk: boolean,
): Header[] => {
  const domain = domainOf(sender.addr);
  const senderIp = `203.0.113.${octet(`${domain}:ip`)}`;
  const googleIp = `198.51.100.${octet(`${key}:mx`)}`;
  const date = rfc2822(clock);
  const seconds = Math.floor(clock.ms / 1000);
  const smtpId = (n: number) => `${sha1(`${key}:smtp:${n}`).slice(0, 12)}`;
  const auth = `${MX}; dkim=pass header.i=@${domain} header.s=s1 header.b=${b64(`${key}:hb`, 8)}; spf=pass (google.example: domain of ${sender.addr} designates ${senderIp} as permitted sender) smtp.mailfrom=${sender.addr}; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`;
  return [
    { name: "Delivered-To", value: recipient },
    { name: "Received", value: `by ${googleIp} with SMTP id ${smtpId(1)}; ${date}` },
    { name: "X-Google-Smtp-Source", value: `AGHT+IE${b64(`${key}:xgss`, 60)}` },
    { name: "X-Received", value: `by ${googleIp} with SMTP id ${smtpId(2)}; ${date}` },
    {
      name: "ARC-Seal",
      value: `i=1; a=rsa-sha256; t=${seconds}; cv=none; d=google.example; s=arc-20240605; b=${b64(`${key}:arcseal`, 40)}`,
    },
    {
      name: "ARC-Message-Signature",
      value: `i=1; a=rsa-sha256; c=relaxed/relaxed; d=google.example; s=arc-20240605; h=to:subject:message-id:date:from:mime-version:dkim-signature; bh=${b64(`${key}:arcbh`, 44)}; b=${b64(`${key}:arcb`, 40)}`,
    },
    { name: "ARC-Authentication-Results", value: `i=1; ${auth}` },
    { name: "Return-Path", value: `<${sender.addr}>` },
    {
      name: "Received",
      value: `from mail.${domain} (mail.${domain}. [${senderIp}]) by ${MX} with ESMTPS id ${smtpId(3)} for <${recipient}> (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256); ${date}`,
    },
    {
      name: "Received-SPF",
      value: `pass (google.example: domain of ${sender.addr} designates ${senderIp} as permitted sender) client-ip=${senderIp};`,
    },
    { name: "Authentication-Results", value: auth },
    {
      name: "DKIM-Signature",
      value: `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=s1; t=${seconds}; h=from:to:subject:date:message-id; bh=${b64(`${key}:bh`, 44)}; b=${b64(`${key}:b`, 40)}`,
    },
    ...(bulk
      ? [{ name: "Feedback-ID", value: `${sha1(`${domain}:fbl`).slice(0, 8)}:mailer:${domain}` }]
      : []),
  ];
};

const threadMessages = (
  t: Thread,
  people: Record<string, Person>,
  me: Person,
): GeneratedMessage[] => {
  const person = (key: string): Person => {
    const p = people[key];
    if (!p) throw new Error(`thread ${t.id} names unknown person ${key}`);
    return p;
  };
  const fmt = (p: Person) => `${p.name} <${p.addr}>`;
  const msgId = (n: number, m: ThreadMessage) =>
    `<${sha1(`${t.id}:${n}:mid`).slice(0, 24)}@${domainOf(person(m.from).addr)}>`;
  const bulk = t.headers?.["List-Unsubscribe"] !== undefined;
  const quotes = t.headers?.["List-ID"] === undefined;
  const plainOnly = t.id === PLAIN_ONLY_THREAD;
  let threadId = "";
  return t.messages.map((m, k) => {
    const clock = wallClock(m.at);
    const id = (
      (BigInt(clock.ms) << 20n) |
      BigInt(Number.parseInt(sha1(`${t.id}:${k}`).slice(0, 5), 16))
    ).toString(16);
    threadId ||= id;
    const from = person(m.from);
    const to = m.to.map(person);
    const cc = (m.cc ?? []).map(person);
    const fromMe = from === me;
    const labelIds = fromMe ? (to.includes(me) ? ["SENT", ...t.labels] : ["SENT"]) : t.labels;
    const subject = k ? `Re: ${t.subject}` : t.subject;
    const prev = k && quotes ? t.messages[k - 1] : undefined;
    const prevSender = prev ? person(prev.from) : undefined;

    const plainParts = [signed(m.text, from)];
    const htmlParts = [messageHtml(m), from.signature ? signatureHtml(from.signature) : ""];
    if (prev && prevSender) {
      const attr = attribution(wallClock(prev.at), prevSender);
      const quoted = signed(prev.text, prevSender).replace(/^/gm, "> ").replace(/^> $/gm, ">");
      plainParts.push(`${attr}\n${quoted}`);
      htmlParts.push(
        `<div class="gmail_quote"><div class="gmail_attr">${escapeHtml(attr)}</div><blockquote class="gmail_quote">${messageHtml(prev)}${prevSender.signature ? signatureHtml(prevSender.signature) : ""}</blockquote></div>`,
      );
    }
    const plain = plainParts.join("\n\n");
    const html = htmlParts.join("");

    const boundary = `000000000000${sha1(id).slice(0, 12)}`;
    const headers: Header[] = [
      ...transportHeaders(`${t.id}:${k}`, from, me.addr, clock, bulk && !fromMe),
      { name: "MIME-Version", value: "1.0" },
      { name: "Date", value: rfc2822(clock) },
      { name: "Message-ID", value: msgId(k, m) },
      ...(k
        ? [
            { name: "In-Reply-To", value: msgId(k - 1, t.messages[k - 1] ?? m) },
            {
              name: "References",
              value: t.messages
                .slice(0, k)
                .map((x, n) => msgId(n, x))
                .join(" "),
            },
          ]
        : []),
      { name: "Subject", value: subject },
      { name: "From", value: fmt(from) },
      { name: "To", value: to.map(fmt).join(", ") },
      ...(cc.length ? [{ name: "Cc", value: cc.map(fmt).join(", ") }] : []),
      ...(fromMe ? [] : Object.entries(t.headers ?? {}).map(([name, value]) => ({ name, value }))),
    ];
    const payload: MessagePart = plainOnly
      ? leaf("", "text/plain", plain, [...headers, contentType("text/plain")])
      : {
          partId: "",
          mimeType: "multipart/alternative",
          filename: "",
          headers: [
            ...headers,
            { name: "Content-Type", value: `multipart/alternative; boundary="${boundary}"` },
          ],
          body: { size: 0 },
          parts: [
            leaf("0", "text/plain", plain, [contentType("text/plain")]),
            leaf("1", "text/html", html, [contentType("text/html")]),
          ],
        };
    const headerBytes = payload.headers.reduce(
      (n, h) => n + Buffer.byteLength(`${h.name}: ${h.value}\r\n`, "utf8"),
      0,
    );
    const bodyBytes = (payload.parts ?? [payload]).reduce((n, p) => n + p.body.size, 0);
    return {
      id,
      threadId,
      labelIds,
      snippet: snippetOf(m.text),
      payload,
      sizeEstimate: headerBytes + bodyBytes,
      internalDate: String(clock.ms),
    };
  });
};

export const gmailMessages = (s: Scenarios): GeneratedMessage[] => {
  const me = s.people[s.me];
  if (!me) throw new Error(`scenarios.me names unknown person ${s.me}`);
  return s.threads.flatMap((t) => threadMessages(t, s.people, me));
};
