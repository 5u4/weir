import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Chip, hitStep, SentenceWidget } from "./Cap.tsx";
import type { Widget } from "./Notch.ts";

vi.hoisted(() => vi.stubGlobal("location", { origin: "http://weir.test", search: "" }));

const widget = (kind: Widget["kind"], name: string, count: number): Widget => ({
  kind,
  view: kind === "cleared" ? "cleared" : `tag:${name}`,
  name,
  count,
  senders: [],
});

const link = (markup: string) => {
  const open = /^<a\b([^>]*)>/.exec(markup);
  if (open === null) throw new Error(`no link in ${markup}`);
  const attrs: Record<string, string> = Object.fromEntries(
    [...(open[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
  );
  return {
    attr: (name: string) => attrs[name] ?? null,
    text: markup.replace(/<[^>]*>/g, ""),
  };
};

const cases = [
  ["updates", widget("updates", "Me", 1), "1 Me", "with updates"],
  ["quiet", widget("quiet", "Work", 2), "2 Work", "read but not done"],
  ["clear", widget("clear", "Home", 0), "Home", "is clear"],
  ["cleared", widget("cleared", "Cleared", 3), "Cleared 3", null],
] as const;

describe.each([
  ["sentence", (w: Widget) => <SentenceWidget widget={w} active={null} />],
  ["chip", (w: Widget) => <Chip widget={w} active={null} />],
])("%s view link", (_, render) => {
  it.each(cases)(
    "%s: name is the visible text, qualifier is the description",
    (_, w, text, qualifier) => {
      const anchor = link(renderToStaticMarkup(render(w)));
      expect(anchor.attr("aria-label")).toBeNull();
      expect(anchor.text).toBe(text);
      expect(anchor.attr("aria-description")).toBe(qualifier);
      expect(anchor.attr("title")).toBe(qualifier);
    },
  );
});

describe("Enter in the result pill", () => {
  const press = (overrides: Partial<Parameters<typeof hitStep>[0]>) => ({
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
  });
  it.each([
    ["Enter steps to the next match", press({}), 1],
    ["Shift+Enter steps to the previous match", press({ shiftKey: true }), -1],
    ["Enter while an IME composes does nothing", press({ isComposing: true }), null],
    ["Safari's IME commit Enter does nothing", press({ keyCode: 229 }), null],
    ["Cmd+Enter is left alone", press({ metaKey: true }), null],
    ["Ctrl+Enter is left alone", press({ ctrlKey: true }), null],
    ["Alt+Enter is left alone", press({ altKey: true }), null],
    ["other keys do nothing", press({ key: "a", keyCode: 65 }), null],
  ] as const)("%s", (_, event, expected) => {
    expect(hitStep(event)).toBe(expected);
  });
});
