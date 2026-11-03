// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Email, emailDocument, emailFrame } from "./Email.tsx";

const email = `<html><head><meta http-equiv="Content-Security-Policy" content="img-src *"><style>body{color:red}</style></head><body><table><tr><td>Lisbon</td></tr></table></body></html>`;

const attribute = (markup: string, name: string) =>
  markup
    .match(new RegExp(` ${name}="([^"]*)"`))?.[1]
    ?.replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

describe("Email", () => {
  const markup = renderToStaticMarkup(<Email html={email} title="Your trip" />);

  it("frames the email in a sandbox that runs no scripts and opens links outside", () => {
    expect(attribute(markup, "sandbox")).toBe(
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    expect(markup).not.toContain("allow-scripts");
    expect(attribute(markup, "referrerPolicy")).toBe("no-referrer");
    expect(attribute(markup, "title")).toBe("Your trip");
    expect(attribute(markup, "srcDoc")).toBe(emailDocument(email));
  });

  it("opens the head with weir's policy so it applies before any of the email's markup", () => {
    const page = emailDocument(email);
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toMatch(/^<!doctype html><html><head><meta charset="utf-8">/);
    expect(head).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:">`,
    );
    expect(page.indexOf("default-src 'none'")).toBeLessThan(page.indexOf("img-src *"));
    expect(page).toContain("<style>body{color:red}</style>");
    expect(page).toContain("<td>Lisbon</td>");
  });

  it("asks for a light page, no referrer, and new tabs for links", () => {
    const page = emailDocument("<p>Hi</p>");
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toContain('<meta name="color-scheme" content="light">');
    expect(head).toContain('<meta name="referrer" content="no-referrer">');
    expect(head).toContain('<base target="_blank">');
  });

  it("opens every link in a new tab with no handle back to weir, whatever the email asked for", () => {
    const page = new DOMParser().parseFromString(
      emailDocument(
        `<a href="https://a.example/" target="_self" rel="opener">a</a><a href="https://b.example/" target="_top">b</a><a href="https://c.example/" rel="opener">c</a><svg><a href="https://d.example/" target="_self"><text>d</text></a></svg><map><area href="https://e.example/" target="inbox" rel="opener nofollow"></map>`,
      ),
      "text/html",
    );
    const links = [...page.querySelectorAll("a, area")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      ["a", "b", "c", "d", "e"].map((host) => `https://${host}.example/`),
    );
    expect(links.map((link) => [link.getAttribute("target"), link.getAttribute("rel")])).toEqual(
      links.map(() => ["_blank", "noopener noreferrer"]),
    );
  });

  it("drops templates so no shadow root can hide a link from that rewrite", () => {
    const page = emailDocument(
      `<div><template shadowrootmode="closed"><a href="https://hidden.example/" rel="opener">x</a></template>Sale</div>`,
    );
    expect(page).toContain("Sale");
    expect(page).not.toContain("template");
    expect(page).not.toContain("hidden.example");
  });
});

class Page extends EventTarget {
  documentElement = { scrollWidth: 600, getBoundingClientRect: () => ({ height: 900 }) };
  body = { scrollHeight: 900 };
  activeElement: Element = document.body;
}

class Frame extends EventTarget {
  clientWidth = 600;
  parentElement = null;
  style = { setProperty: () => {}, removeProperty: () => {} };
  contentDocument: Page;
  constructor(contentDocument: Page) {
    super();
    this.contentDocument = contentDocument;
    emailFrame(this as unknown as HTMLIFrameElement);
  }
}

class Wheel extends Event {
  deltaY: number;
  constructor(type: string, init: WheelEventInit = {}) {
    super(type, { bubbles: init.bubbles ?? false, cancelable: init.cancelable ?? false });
    this.deltaY = init.deltaY ?? 0;
  }
}

class Pointer extends Event {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, { bubbles: init.bubbles ?? false, cancelable: init.cancelable ?? false });
    this.pointerType = init.pointerType ?? "";
  }
}

class Keyboard extends Event {
  key: string;
  constructor(type: string, init: KeyboardEventInit = {}) {
    super(type, { bubbles: init.bubbles ?? false, cancelable: init.cancelable ?? false });
    this.key = init.key ?? "";
  }
}

describe("emailFrame", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("WheelEvent", Wheel);
    vi.stubGlobal("PointerEvent", Pointer);
    vi.stubGlobal("KeyboardEvent", Keyboard);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hands reading input inside the email to the iframe as bubbling events", () => {
    const page = new Page();
    const frame = new Frame(page);
    frame.dispatchEvent(new Event("load"));
    const seen: Array<Event> = [];
    for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) {
      frame.addEventListener(type, (event) => seen.push(event));
    }
    page.dispatchEvent(new Wheel("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
    page.dispatchEvent(new Event("touchmove", { bubbles: true, cancelable: true }));
    page.dispatchEvent(new Pointer("pointerdown", { bubbles: true, pointerType: "mouse" }));
    page.dispatchEvent(new Keyboard("keydown", { bubbles: true, key: "PageDown" }));
    expect(seen.map((event) => [event.type, event.bubbles])).toEqual([
      ["wheel", true],
      ["touchmove", true],
      ["pointerdown", true],
      ["keydown", true],
    ]);
    expect((seen[0] as Wheel).deltaY).toBe(120);
    expect((seen[2] as Pointer).pointerType).toBe("mouse");
    expect((seen[3] as Keyboard).key).toBe("PageDown");
  });

  it("relays input from each document the frame loads", () => {
    const frame = new Frame(new Page());
    frame.dispatchEvent(new Event("load"));
    const next = new Page();
    frame.contentDocument = next;
    frame.dispatchEvent(new Event("load"));
    const seen: Array<string> = [];
    frame.addEventListener("keydown", (event) => seen.push((event as Keyboard).key));
    next.dispatchEvent(new Keyboard("keydown", { bubbles: true, key: "ArrowDown" }));
    expect(seen).toEqual(["ArrowDown"]);
  });

  it("keeps keys typed into a field in the email to the email", () => {
    const page = new Page();
    const frame = new Frame(page);
    frame.dispatchEvent(new Event("load"));
    const seen: Array<string> = [];
    frame.addEventListener("keydown", (event) => seen.push((event as Keyboard).key));
    page.activeElement = document.createElement("textarea");
    page.dispatchEvent(new Keyboard("keydown", { bubbles: true, key: "e" }));
    page.activeElement = document.body;
    page.dispatchEvent(new Keyboard("keydown", { bubbles: true, key: "PageDown" }));
    expect(seen).toEqual(["PageDown"]);
  });
});
