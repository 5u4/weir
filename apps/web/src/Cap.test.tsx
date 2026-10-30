import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Chip, changeOf, hitStep, popOf, rollOf, type Seen, SentenceWidget } from "./Cap.tsx";
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

const rerender = <A, B>(values: ReadonlyArray<A>, change: (from: A, to: A) => B) => {
  let seen: Seen<A, B> = { value: values[0] as A, change: undefined };
  const renders = [seen];
  for (const value of values.slice(1)) {
    seen = changeOf(seen, value, change);
    renders.push(seen);
  }
  return renders;
};

describe("count roll and chip pop", () => {
  it("a count rolls up when it rises, down when it falls, and keeps its roll on an unchanged rerender", () => {
    const renders = rerender([4, 5, 5, 3, 7], rollOf);
    expect(renders.map(({ change }) => change)).toEqual([undefined, "up", "up", "down", "up"]);
    expect(renders[2]).toBe(renders[1]);
  });

  it("a view pops each time it is picked again, and not on an unchanged rerender", () => {
    const renders = rerender([false, true, true, false, true], popOf);
    expect(renders.map(({ change }) => change)).toEqual([undefined, true, true, false, true]);
    expect(renders[2]).toBe(renders[1]);
  });

  it.each([
    [
      "sentence",
      <SentenceWidget key="sentence" widget={widget("updates", "Me", 2)} active="tag:Me" />,
    ],
    ["chip", <Chip key="chip" widget={widget("updates", "Me", 2)} active="tag:Me" />],
  ])("a %s mounted already current neither pops nor rolls", (_, element) => {
    const markup = renderToStaticMarkup(element);
    expect(link(markup).attr("aria-current")).toBe("page");
    expect(markup).not.toContain("data-pop");
    expect(markup).not.toContain("data-roll");
  });
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
