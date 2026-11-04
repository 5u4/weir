// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react/RegistryContext";
import type { Event } from "@weir/daemon/Api";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, Avatars } from "./Avatar.tsx";
import { observeFaces } from "./Faces.ts";

const rendered = (node: ReactNode, ...events: ReadonlyArray<Event>) => {
  const registry = AtomRegistry.make();
  for (const event of events) observeFaces(registry, event);
  return renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>{node}</RegistryContext.Provider>,
  );
};

const images = (markup: string) =>
  [...markup.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map(([, src]) =>
    src?.replaceAll("&amp;", "&"),
  );

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Avatar", () => {
  it("asks the daemon for the sender's face under the monogram", () => {
    const markup = rendered(
      <Avatar source="gmail" address="ada@example.com" verified={false} mark="A" />,
    );
    expect(images(markup)).toEqual(["/faces?source=gmail&address=ada%40example.com"]);
    expect(markup).toContain('data-m="A"');
    expect(markup).toMatch(/<img\b[^>]*\balt=""/);
    expect(markup).toMatch(/<img\b[^>]*\bloading="lazy"/);
  });

  it("asks for a brand logo only when the sender is verified", () => {
    const markup = rendered(
      <>
        <Avatar source="gmail" address="ada@example.com" verified mark="A" />
        <Avatar source="gmail" address="bo@example.com" verified={false} mark="B" />
      </>,
      { type: "faces", source: "gmail", addresses: ["ada@example.com"] },
    );
    expect(images(markup)).toEqual([
      "/faces?source=gmail&address=ada%40example.com&verified=1&v=0.1",
      "/faces?source=gmail&address=bo%40example.com",
    ]);
  });

  it("drops a loaded face when the sender's verification changes", async () => {
    const registry = AtomRegistry.make();
    const host = document.createElement("div");
    const root = createRoot(host);
    const show = (verified: boolean) =>
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Avatar source="gmail" address="ada@example.com" verified={verified} mark="A" />
          </RegistryContext.Provider>,
        ),
      );
    await show(true);
    host.querySelector("img")?.dispatchEvent(new globalThis.Event("load"));
    await show(false);
    const img = host.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/faces?source=gmail&address=ada%40example.com");
    expect(img?.hasAttribute("data-loaded")).toBe(false);
    await act(() => root.unmount());
  });

  it("normalizes the address, so a mixed-case sender shares the face url", () => {
    const markup = rendered(
      <Avatar source="gmail" address=" Ada@Example.COM " verified={false} mark="A" />,
    );
    expect(images(markup)).toEqual(["/faces?source=gmail&address=ada%40example.com"]);
  });

  it("shows only the monogram when there is no address", () => {
    const markup = rendered(<Avatar source="gmail" address="" verified={false} mark="?" />);
    expect(images(markup)).toEqual([]);
    expect(markup).toContain('data-m="?"');
  });

  it("re-asks with a new url once the daemon announces that face", () => {
    const markup = rendered(
      <Avatar source="gmail" address="Ada@example.com" verified={false} mark="A" />,
      { type: "faces", source: "gmail", addresses: ["ada@example.com"] },
    );
    expect(images(markup)).toEqual(["/faces?source=gmail&address=ada%40example.com&v=0.1"]);
  });

  it("gives each cap sender the face of its own source", () => {
    const markup = rendered(
      <Avatars
        senders={[
          { source: "gmail", name: "Ada", address: "ada@example.com", verified: false },
          { source: "work", name: "Bo", address: "bo@corp.example", verified: true },
        ]}
      />,
    );
    expect(images(markup)).toEqual([
      "/faces?source=gmail&address=ada%40example.com",
      "/faces?source=work&address=bo%40corp.example&verified=1",
    ]);
  });

  it("does not keep the previous sender's loaded face when the sender changes", async () => {
    const registry = AtomRegistry.make();
    const host = document.createElement("div");
    const root = createRoot(host);
    const show = (address: string) =>
      act(() =>
        root.render(
          <RegistryContext.Provider value={registry}>
            <Avatar source="gmail" address={address} verified={false} mark="A" />
          </RegistryContext.Provider>,
        ),
      );
    await show("ada@example.com");
    host.querySelector("img")?.dispatchEvent(new globalThis.Event("load"));
    expect(host.querySelector("img")?.hasAttribute("data-loaded")).toBe(true);
    await show("bo@example.com");
    const img = host.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/faces?source=gmail&address=bo%40example.com");
    expect(img?.hasAttribute("data-loaded")).toBe(false);
    await act(() => root.unmount());
  });

  it("falls back to the monogram when a re-asked face is gone", async () => {
    const registry = AtomRegistry.make();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <Avatar source="gmail" address="ada@example.com" verified={false} mark="A" />
        </RegistryContext.Provider>,
      ),
    );
    host.querySelector("img")?.dispatchEvent(new globalThis.Event("load"));
    await act(() =>
      observeFaces(registry, { type: "faces", source: "gmail", addresses: ["ada@example.com"] }),
    );
    const img = host.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/faces?source=gmail&address=ada%40example.com&v=0.1");
    img?.dispatchEvent(new globalThis.Event("error"));
    expect(img?.hasAttribute("data-loaded")).toBe(false);
    await act(() => root.unmount());
  });
});
