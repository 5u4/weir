import type { Event } from "@weir/daemon/Api";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "vitest";
import { faceSrc, observeFaces } from "./Faces.ts";

const ada = "/faces?source=gmail&address=ada%40example.com";
const bo = "/faces?source=gmail&address=bo%40example.com";
const reloaded = { type: "reload", status: "ok", at: "2026-11-03T09:00:00.000Z" } satisfies Event;

const observed = (...events: ReadonlyArray<Event>) => {
  const registry = AtomRegistry.make();
  for (const event of events) observeFaces(registry, event);
  return (path: string) => registry.get(faceSrc(path));
};

describe("face urls", () => {
  it("stay the bare identity url until something announces a change", () => {
    expect(observed()(ada)).toBe(ada);
  });

  it("a faces event re-asks only the addresses it names", () => {
    const src = observed({ type: "faces", source: "gmail", addresses: ["ada@example.com"] });
    expect(src(ada)).toBe(`${ada}&v=0.1`);
    expect(src(bo)).toBe(bo);
  });

  it("a faces event for another source leaves this source's avatar alone", () => {
    const src = observed({ type: "faces", source: "work", addresses: ["ada@example.com"] });
    expect(src(ada)).toBe(ada);
  });

  it("each faces event for a key gives it a new url", () => {
    const event = { type: "faces", source: "gmail", addresses: ["ada@example.com"] } as const;
    expect(observed(event, event)(ada)).toBe(`${ada}&v=0.2`);
  });

  it("every ready re-asks every avatar, so a faces event missed before connecting is recovered", () => {
    expect(observed({ type: "ready" })(bo)).toBe(`${bo}&v=1.0`);
    expect(observed({ type: "ready" }, { type: "ready" })(bo)).toBe(`${bo}&v=2.0`);
  });

  it("a successful reload re-asks every avatar, a failed one does not", () => {
    expect(observed(reloaded)(bo)).toBe(`${bo}&v=1.0`);
    const failed = {
      type: "reload",
      status: "failed",
      error: { file: "config.toml", message: "bad", issues: [] },
      at: "2026-11-03T09:00:00.000Z",
    } satisfies Event;
    expect(observed(failed)(bo)).toBe(bo);
  });

  it("round and per-key version combine", () => {
    const src = observed(
      { type: "ready" },
      { type: "faces", source: "gmail", addresses: ["ada@example.com"] },
      reloaded,
      { type: "ready" },
    );
    expect(src(ada)).toBe(`${ada}&v=3.1`);
    expect(src(bo)).toBe(`${bo}&v=3.0`);
  });
});
