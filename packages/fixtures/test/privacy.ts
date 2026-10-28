const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"];
const DOCUMENTATION_NETS = ["192.0.2.", "198.51.100.", "203.0.113."];
const PROSE_TLDS = new Set(
  "com net org edu gov mil int io co ai app dev me info biz us uk ca de fr jp cn au in nl ru br es it ch se no eu xyz tech cloud".split(
    " ",
  ),
);
const AUTH_RESULT_PROPERTY = /^(header|smtp|policy)\.[a-z]+$/i;

const EMAIL = /[\w.+-]+@((?:[a-z0-9-]+\.)+[a-z0-9-]+)/gi;
const URL = /\b[a-z][a-z0-9+.-]*:\/\/([^/\s:?#<>()"'\]]+)[^\s<>()"']*/gi;
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g;
const HOSTNAME =
  /(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9](?![\w-])/gi;

const tldOf = (host: string) => host.slice(host.lastIndexOf(".") + 1).toLowerCase();

const reservedHost = (host: string) => {
  const h = host.toLowerCase().replace(/\.$/, "");
  return (
    RESERVED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)) || RESERVED_TLDS.includes(tldOf(h))
  );
};

export type Field = "structured" | "prose";

export const offendingValues = (text: string, field: Field): string[] => {
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
    .replace(IPV4, (ip) => {
      if (!DOCUMENTATION_NETS.some((net) => ip.startsWith(net))) found.push(ip);
      return " ";
    });
  for (const host of rest.match(HOSTNAME) ?? []) {
    if (field === "prose" && !PROSE_TLDS.has(tldOf(host))) continue;
    if (!AUTH_RESULT_PROPERTY.test(host) && !reservedHost(host)) found.push(host);
  }
  return found;
};

const PROSE_KEYS = new Set(["text", "signature", "snippet", "data"]);

export const privacyReport = (source: string, value: unknown): string[] => {
  const report: string[] = [];
  const walk = (v: unknown, path: string, key: string, parentKey: string) => {
    if (typeof v === "string") {
      const decoded = key === "data" && parentKey === "body";
      const text = decoded ? Buffer.from(v, "base64url").toString("utf8") : v;
      const field = PROSE_KEYS.has(key) ? "prose" : "structured";
      for (const bad of offendingValues(text, field)) {
        report.push(`${bad} @ ${source} ${path}${decoded ? " (decoded)" : ""}`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        walk(x, `${path}[${i}]`, key, parentKey);
      });
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k, key);
    }
  };
  walk(value, "", "", "");
  return report;
};
