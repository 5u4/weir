export interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

export interface Extension {
  readonly critical: boolean;
  readonly value: Uint8Array;
}

export interface BasicConstraints {
  readonly ca: boolean;
  readonly pathLen: number | null;
}

const boolean = 0x01;
const integer = 0x02;
const octetString = 0x04;
const objectIdentifier = 0x06;
const sequence = 0x30;
const constructed = 0x20;
const ia5String = 0x16;
const maxDepth = 16;
const maxArcBytes = 7;
const logotypeOid = "1.3.6.1.5.5.7.1.12";

export const readTlv = (der: Uint8Array, offset: number, limit: number): Tlv => {
  if (offset + 2 > limit) throw new Error(`DER: truncated header at ${offset}`);
  const tag = der[offset] ?? 0;
  if ((tag & 0x1f) === 0x1f) throw new Error(`DER: multi-byte tag at ${offset}`);
  const first = der[offset + 1] ?? 0;
  let start = offset + 2;
  let length = first;
  if (first === 0x80) throw new Error(`DER: indefinite length at ${offset}`);
  if (first > 0x80) {
    const count = first & 0x7f;
    if (count > 4) throw new Error(`DER: length of ${count} bytes at ${offset}`);
    if (start + count > limit) throw new Error(`DER: truncated length at ${offset}`);
    length = 0;
    for (const byte of der.subarray(start, start + count)) length = length * 256 + byte;
    start += count;
  }
  const end = start + length;
  if (end > limit) throw new Error(`DER: value at ${offset} runs past its parent`);
  return { tag, start, end };
};

const children = (der: Uint8Array, parent: Tlv): ReadonlyArray<Tlv> => {
  const found: Tlv[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = readTlv(der, at, parent.end);
    found.push(child);
    at = child.end;
  }
  return found;
};

const only = (der: Uint8Array, offset: number, limit: number, tag: number): Tlv => {
  const tlv = readTlv(der, offset, limit);
  if (tlv.tag !== tag || tlv.end !== limit)
    throw new Error(`DER: expected one tag ${tag} at ${offset}`);
  return tlv;
};

const decodeOid = (der: Uint8Array, node: Tlv): string => {
  const arcs: number[] = [];
  let arc = 0;
  let bytes = 0;
  for (const byte of der.subarray(node.start, node.end)) {
    if (++bytes > maxArcBytes)
      throw new Error(`DER: object identifier arc too long at ${node.start}`);
    arc = arc * 128 + (byte & 0x7f);
    if ((byte & 0x80) !== 0) continue;
    arcs.push(arc);
    arc = 0;
    bytes = 0;
  }
  const [first] = arcs;
  if (first === undefined || bytes !== 0)
    throw new Error(`DER: bad object identifier at ${node.start}`);
  const head = first < 80 ? [Math.floor(first / 40), first % 40] : [2, first - 80];
  return [...head, ...arcs.slice(1)].join(".");
};

export const extensions = (der: Uint8Array): ReadonlyMap<string, Extension> => {
  const certificate = readTlv(der, 0, der.length);
  const [tbs] = children(der, certificate);
  if (tbs === undefined) throw new Error("DER: certificate has no tbsCertificate");
  const wrapper = children(der, tbs).find((field) => field.tag === 0xa3);
  const found = new Map<string, Extension>();
  if (wrapper === undefined) return found;
  const list = only(der, wrapper.start, wrapper.end, sequence);
  for (const entry of children(der, list)) {
    const fields = children(der, entry);
    const [id, flag] = fields;
    const value = fields.at(-1);
    const flagged = fields.length === 3 && flag?.tag === boolean && flag.end === flag.start + 1;
    if (
      entry.tag !== sequence ||
      id?.tag !== objectIdentifier ||
      value?.tag !== octetString ||
      (fields.length !== 2 && !flagged)
    ) {
      throw new Error(`DER: malformed extension at ${entry.start}`);
    }
    const oid = decodeOid(der, id);
    if (found.has(oid)) throw new Error(`DER: extension ${oid} appears twice`);
    found.set(oid, {
      critical: flagged && der[flag.start] !== 0,
      value: der.subarray(value.start, value.end),
    });
  }
  return found;
};

export const basicConstraints = (value: Uint8Array): BasicConstraints => {
  const fields = children(value, only(value, 0, value.length, sequence));
  let at = 0;
  let ca = false;
  let pathLen: number | null = null;
  const flag = fields[at];
  if (flag?.tag === boolean && flag.end === flag.start + 1) {
    ca = value[flag.start] !== 0;
    at++;
  }
  const limit = fields[at];
  if (
    limit?.tag === integer &&
    limit.end - limit.start <= 4 &&
    (value[limit.start] ?? 0x80) < 0x80
  ) {
    pathLen = 0;
    for (const byte of value.subarray(limit.start, limit.end)) pathLen = pathLen * 256 + byte;
    at++;
  }
  if (at !== fields.length) throw new Error("DER: malformed basicConstraints");
  return { ca, pathLen };
};

export const logotypeUris = (der: Uint8Array): ReadonlyArray<string> => {
  const value = extensions(der).get(logotypeOid)?.value;
  if (value === undefined) return [];
  const uris: string[] = [];
  const walk = (node: Tlv, depth: number) => {
    if (node.tag === ia5String) {
      uris.push(new TextDecoder("ascii").decode(value.subarray(node.start, node.end)));
    } else if ((node.tag & constructed) !== 0 && depth < maxDepth) {
      for (const child of children(value, node)) walk(child, depth + 1);
    }
  };
  walk(readTlv(value, 0, value.length), 0);
  return uris;
};
