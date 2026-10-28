import { isIPv6 } from "node:net";

const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"];
const DOCUMENTATION_NETS = ["192.0.2.", "198.51.100.", "203.0.113."];
const CODE_IDENTIFIERS = ["invoice.created", "InvoiceWriter.create", "webhook.ts"];
const AUTH_RESULT_PROPERTY = /^(header|smtp|policy)\.[a-z]+$/i;
const AUTH_RESULT_HEADERS = ["Authentication-Results", "ARC-Authentication-Results"];

const EMAIL = /[\w.+-]+@((?:[a-z0-9-]+\.)+[a-z0-9-]+)/gi;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/([^/\s:?#<>()"'\]]+)[^\s<>()"']*/gi;
const IPV6_CANDIDATE = /(?<![\w:])[0-9a-f]*(?::[0-9a-f]*){2,}(?![\w:])/gi;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const HOSTNAME = /(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?![\w-])/gi;

const reservedHost = (host: string) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    RESERVED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)) ||
    RESERVED_TLDS.includes(h.slice(h.lastIndexOf(".") + 1))
  );
};

type Field = "text" | "auth-results";

export const offendingValues = (text: string, field: Field = "text"): string[] => {
  const found: string[] = [];
  const rest = text
    .replace(EMAIL, (address, domain: string) => {
      if (!reservedHost(domain)) found.push(address);
      return " ";
    })
    .replace(URL, (url, host: string) => {
      if (!reservedHost(host)) found.push(url);
      return " ";
    })
    .replace(IPV6_CANDIDATE, (candidate) => {
      if (!isIPv6(candidate)) return candidate;
      const [first = "", second = ""] = candidate.split(":");
      if (Number.parseInt(first, 16) !== 0x2001 || Number.parseInt(second, 16) !== 0xdb8) {
        found.push(candidate);
      }
      return " ";
    })
    .replace(IPV4, (ip) => {
      if (!DOCUMENTATION_NETS.some((net) => ip.startsWith(net))) found.push(ip);
      return " ";
    });
  for (const match of rest.matchAll(HOSTNAME)) {
    const host = match[0];
    const authProperty =
      field === "auth-results" &&
      AUTH_RESULT_PROPERTY.test(host) &&
      rest[match.index + host.length] === "=";
    if (CODE_IDENTIFIERS.includes(host) || authProperty || reservedHost(host)) continue;
    found.push(host);
  }
  return found;
};

export const privacyReport = (source: string, value: unknown): string[] => {
  const report: string[] = [];
  const walk = (v: unknown, path: string, key: string, parentKey: string, field: Field) => {
    if (typeof v === "string") {
      const decoded = key === "data" && parentKey === "body";
      const text = decoded ? Buffer.from(v, "base64url").toString("utf8") : v;
      for (const bad of offendingValues(text, key === "value" ? field : "text")) {
        report.push(`${bad} @ ${source} ${path}${decoded ? " (decoded)" : ""}`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        walk(x, `${path}[${i}]`, key, parentKey, "text");
      });
    } else if (v !== null && typeof v === "object") {
      const name = "name" in v ? v.name : undefined;
      const objectField: Field =
        typeof name === "string" && AUTH_RESULT_HEADERS.includes(name) ? "auth-results" : "text";
      for (const [k, x] of Object.entries(v)) {
        walk(x, path ? `${path}.${k}` : k, k, key, objectField);
      }
    }
  };
  walk(value, "", "", "", "text");
  return report;
};
