import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { face, faceBlob } from "../src/Read.ts";
import { putFaces } from "../src/Write.ts";
import { storeLayer } from "./fixtures.ts";

const svg = (label: string) =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><title>${label}</title></svg>`);

const found = (address: string, bytes: Uint8Array) =>
  ({ address, status: "found", kind: "portrait", mime: "image/svg+xml", bytes }) as const;

const missing = (address: string) => ({ address, status: "missing" }) as const;

const hashOf = (address: string) =>
  face("gws", address).pipe(
    Effect.map(Option.flatMap(({ hash }) => Option.fromNullishOr(hash))),
    Effect.flatMap(Effect.fromOption),
  );

const at = DateTime.makeUnsafe("2026-11-01T00:00:00Z");

describe("faces", () => {
  it.effect("addresses sharing an image share one blob until the last one moves away", () =>
    Effect.gen(function* () {
      const logo = svg("logo");
      yield* putFaces(
        "gws",
        [found("rachel@northwind.example", logo), found("omar@northwind.example", logo)],
        at,
      );
      const shared = yield* hashOf("rachel@northwind.example");
      expect(yield* hashOf("omar@northwind.example")).toBe(shared);
      expect(Option.map(yield* faceBlob(shared), ({ mime }) => mime)).toEqual(
        Option.some("image/svg+xml"),
      );

      yield* putFaces("gws", [missing("rachel@northwind.example")], at);
      expect(Option.isSome(yield* faceBlob(shared))).toBe(true);

      yield* putFaces("gws", [found("omar@northwind.example", svg("omar"))], at);
      expect(Option.isNone(yield* faceBlob(shared))).toBe(true);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("reports addresses whose image changed, including to none", () =>
    Effect.gen(function* () {
      const ada = svg("ada");
      expect(
        yield* putFaces("gws", [found("ada@example.com", ada), missing("bo@example.com")], at),
      ).toEqual(["ada@example.com"]);
      expect(yield* putFaces("gws", [found("ada@example.com", ada)], at)).toEqual([]);
      expect(yield* putFaces("gws", [missing("ada@example.com")], at)).toEqual(["ada@example.com"]);
      expect(yield* putFaces("gws", [missing("ada@example.com")], at)).toEqual([]);
      expect(yield* putFaces("gws", [found("ada@example.com", ada)], at)).toEqual([
        "ada@example.com",
      ]);
      expect(yield* putFaces("other", [found("ada@example.com", ada)], at)).toEqual([
        "ada@example.com",
      ]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("reports an address whose face kind changed with the same image", () =>
    Effect.gen(function* () {
      const mark = svg("mark");
      yield* putFaces("gws", [found("ada@example.com", mark)], at);
      expect(
        yield* putFaces("gws", [{ ...found("ada@example.com", mark), kind: "logo" }], at),
      ).toEqual(["ada@example.com"]);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("a missing face is remembered with the time it was looked up", () =>
    Effect.gen(function* () {
      yield* putFaces("gws", [missing("bo@example.com")], at);
      const row = yield* face("gws", "bo@example.com");
      expect(
        Option.map(row, ({ hash, fetchedAt }) => [hash, DateTime.formatIso(fetchedAt)]),
      ).toEqual(Option.some([null, "2026-11-01T00:00:00.000Z"]));
      expect(Option.isNone(yield* face("gws", "nobody@example.com"))).toBe(true);
    }).pipe(Effect.provide(storeLayer())),
  );
});
