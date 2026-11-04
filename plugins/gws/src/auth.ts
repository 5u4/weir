import { getDomain } from "tldts";

const gmail = "mx.google.com";

const resinfos = (value: string) => {
  const segments: Array<Array<string>> = [];
  let segment: Array<string> = [];
  let token = "";
  let depth = 0;
  let quoted = false;
  const flush = () => {
    if (token !== "") segment.push(token);
    token = "";
  };
  for (let at = 0; at < value.length; at++) {
    const char = value.charAt(at);
    if (quoted) {
      token += char;
      if (char === "\\") token += value.charAt(++at);
      else if (char === '"') quoted = false;
    } else if (depth > 0) {
      if (char === "\\") at++;
      else if (char === "(") depth++;
      else if (char === ")") depth--;
    } else if (char === "(") {
      flush();
      depth = 1;
    } else if (char === ";") {
      flush();
      segments.push(segment);
      segment = [];
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
      if (char === '"') quoted = true;
    }
  }
  flush();
  segments.push(segment);
  return segments;
};

export const dmarcAligned = (authenticationResults: string | null, address: string) => {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1).toLowerCase();
  if (authenticationResults === null || at < 0 || domain === "") return false;
  const aligned = [domain, getDomain(domain) ?? domain];
  const [[authservId] = [], ...results] = resinfos(authenticationResults);
  return (
    authservId?.toLowerCase() === gmail &&
    results.some(
      ([result, ...properties]) =>
        result?.toLowerCase() === "dmarc=pass" &&
        properties.some((property) => {
          const equals = property.indexOf("=");
          return (
            property.slice(0, equals).toLowerCase() === "header.from" &&
            aligned.includes(property.slice(equals + 1).toLowerCase())
          );
        }),
    )
  );
};
