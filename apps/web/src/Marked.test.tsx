import { hast } from "@weir/daemon/Markdown";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Prose } from "./Marked.tsx";

const render = (markdown: string, pattern: RegExp | null = null) =>
  renderToStaticMarkup(<Prose tree={hast(markdown)} pattern={pattern} />).replaceAll(
    / class="[^"]*"/g,
    "",
  );

const a = (href: string, text: string) =>
  `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;

const img = (src: string, alt: string) =>
  `<img src="${src}" alt="${alt}" referrerPolicy="no-referrer" loading="lazy"/>`;

describe("Prose", () => {
  it.each([
    [
      "an https image renders without a referrer and loads lazily",
      "See ![Sales chart](https://cdn.example/chart.png) below",
      `<p>See ${img("https://cdn.example/chart.png", "Sales chart")} below</p>`,
    ],
    [
      "an empty-alt https image keeps an empty alt and its paragraph",
      "![](https://cdn.example/pixel.gif)",
      `<p>${img("https://cdn.example/pixel.gif", "")}</p>`,
    ],
    [
      "an http image becomes its alt",
      "See ![Sales chart](http://cdn.example/chart.png) below",
      "<p>See <span>Sales chart</span> below</p>",
    ],
    ["a cid: image becomes its alt", "![Logo](cid:logo@mail.example)", "<p><span>Logo</span></p>"],
    ["a relative image becomes its alt", "![Logo](/logo.png)", "<p><span>Logo</span></p>"],
    [
      "a protocol-relative image becomes its alt",
      "![Logo](//cdn.example/logo.png)",
      "<p><span>Logo</span></p>",
    ],
    ["an empty-alt http image is dropped with its paragraph", "![](http://cdn.example/p.gif)", ""],
    [
      "a linked empty-alt http image leaves no link",
      "[![](http://cdn.example/banner.png)](https://news.example/48)\n\nHello",
      "<p>Hello</p>",
    ],
    [
      "an unnamed image-only link is labelled by its destination",
      "[![](https://cdn.example/banner.png)](https://news.example/48)",
      `<p><a href="https://news.example/48" target="_blank" rel="noreferrer noopener" aria-label="news.example/48">${img("https://cdn.example/banner.png", "")}</a></p>`,
    ],
    [
      "an image-only link takes its name from the image alt",
      "[![Sponsor](https://cdn.example/s.png)](https://news.example/s)",
      `<p>${a("https://news.example/s", img("https://cdn.example/s.png", "Sponsor"))}</p>`,
    ],
    [
      "a link with text beside an empty-alt image keeps its text name",
      "[![](https://cdn.example/i.png) Read more](https://news.example/r)",
      `<p>${a("https://news.example/r", `${img("https://cdn.example/i.png", "")} Read more`)}</p>`,
    ],
    [
      "a linked http image with alt links its alt",
      "[![Sponsor](http://cdn.example/s.png)](https://news.example/s)",
      `<p>${a("https://news.example/s", "<span>Sponsor</span>")}</p>`,
    ],
    [
      "a reference image resolves through its definition",
      "![Chart][c]\n\n[c]: https://cdn.example/c.png",
      `<p>${img("https://cdn.example/c.png", "Chart")}</p>`,
    ],
    [
      "a literal img tag stays text",
      'see <img src="https://cdn.example/x.png">',
      "<p>see &lt;img src=&quot;https://cdn.example/x.png&quot;&gt;</p>",
    ],
    ["a javascript: link keeps only its text", "[click](javascript:alert(1))", "<p>click</p>"],
    [
      "a data: link keeps only its text",
      "[open](data:text/html;base64,PHNjcmlwdD4=)",
      "<p>open</p>",
    ],
    ["a relative link keeps only its text", "[home](/index.html)", "<p>home</p>"],
    [
      "a mailto link survives",
      "[write](mailto:a@news.example)",
      `<p>${a("mailto:a@news.example", "write")}</p>`,
    ],
    [
      "a bare URL over 56 chars shows host and path with the URL as title",
      "Read https://news.example/issues/48/offline-sync-three-months-in?utm_source=mail",
      '<p>Read <a href="https://news.example/issues/48/offline-sync-three-months-in?utm_source=mail" target="_blank" rel="noreferrer noopener" title="https://news.example/issues/48/offline-sync-three-months-in?utm_source=mail">news.example/issues/48/offline-sync-…</a></p>',
    ],
    [
      "a long mailto link keeps its full address",
      "<mailto:unsubscribe-weekly-digest-robin@lists.trailhead-weekly.example>",
      `<p>${a(
        "mailto:unsubscribe-weekly-digest-robin@lists.trailhead-weekly.example",
        "mailto:unsubscribe-weekly-digest-robin@lists.trailhead-weekly.example",
      )}</p>`,
    ],
    ["inline HTML is text", "prints <b>raw</b> tags", "<p>prints &lt;b&gt;raw&lt;/b&gt; tags</p>"],
    [
      "block HTML is text",
      '<div style="x">hi</div>',
      "<p>&lt;div style=&quot;x&quot;&gt;hi&lt;/div&gt;</p>",
    ],
    [
      "entities and escapes are decoded",
      "Fish &amp; chips \\*not bold\\*",
      "<p>Fish &amp; chips *not bold*</p>",
    ],
    ["a soft break stays inside the text", "line one\nline two", "<p>line one\nline two</p>"],
    [
      "a reference link resolves through its first definition",
      "[docs][d]\n\n[d]: https://first.example/docs\n[d]: https://second.example/docs",
      `<p>${a("https://first.example/docs", "docs")}</p>`,
    ],
    [
      "task items carry their box as text",
      "- [ ] todo\n- [x] done",
      "<ul><li><p>[ ] todo</p></li><li><p>[x] done</p></li></ul>",
    ],
    [
      "a footnote stays in place with its label",
      "Note[^1].\n\n[^1]: The foot.",
      "<p>Note[1].</p><p>The foot.</p>",
    ],
    [
      "an ordered list keeps a start other than 1",
      "5. five",
      '<ol start="5"><li><p>five</p></li></ol>',
    ],
  ])("%s", (_, markdown, expected) => {
    expect(render(markdown)).toBe(expected);
  });

  it("keeps headings two levels down, lists, quotes, code, rules and tables", () => {
    expect(
      render(
        "# Title\n\n- one\n- two\n\n> quoted\n\n```js\ncode()\n```\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |",
      ),
    ).toBe(
      "<h3>Title</h3><ul><li><p>one</p></li><li><p>two</p></li></ul><blockquote><p>quoted</p></blockquote><pre><code>code()</code></pre><hr/><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
  });

  it("marks matches inside text, code and fallback image alts, but not loaded image alts", () => {
    expect(
      render(
        "Sales `sale()` ![sale](http://cdn.example/s.png) ![sale](https://cdn.example/s.png)",
        /sale/giu,
      ),
    ).toBe(
      `<p><mark>Sale</mark>s <code><mark>sale</mark>()</code> <span><mark>sale</mark></span> ${img("https://cdn.example/s.png", "sale")}</p>`,
    );
  });
});
