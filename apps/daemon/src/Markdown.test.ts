import { describe, expect, it } from "vitest";
import { leaves, plainText, visible } from "./Markdown.ts";

describe("visible", () => {
  it.each([
    [
      "an image with alt becomes its alt",
      "See ![Sales chart](https://cdn.example/chart.png) below",
      [
        {
          _tag: "Paragraph",
          children: [
            { _tag: "Text", text: "See " },
            { _tag: "ImageAlt", alt: "Sales chart" },
            { _tag: "Text", text: " below" },
          ],
        },
      ],
    ],
    ["an empty-alt image is dropped with its paragraph", "![](https://cdn.example/pixel.gif)", []],
    [
      "a linked empty-alt image leaves no link",
      "[![](https://cdn.example/banner.png)](https://news.example/48)\n\nHello",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "Hello" }] }],
    ],
    [
      "a linked image with alt links its alt",
      "[![Sponsor](https://cdn.example/s.png)](https://news.example/s)",
      [
        {
          _tag: "Paragraph",
          children: [
            {
              _tag: "Link",
              href: "https://news.example/s",
              title: null,
              children: [{ _tag: "ImageAlt", alt: "Sponsor" }],
            },
          ],
        },
      ],
    ],
    [
      "a javascript: link keeps only its text",
      "[click](javascript:alert(1))",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "click" }] }],
    ],
    [
      "a data: link keeps only its text",
      "[open](data:text/html;base64,PHNjcmlwdD4=)",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "open" }] }],
    ],
    [
      "a relative link keeps only its text",
      "[home](/index.html)",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "home" }] }],
    ],
    [
      "a mailto link survives",
      "[write](mailto:a@news.example)",
      [
        {
          _tag: "Paragraph",
          children: [
            {
              _tag: "Link",
              href: "mailto:a@news.example",
              title: null,
              children: [{ _tag: "Text", text: "write" }],
            },
          ],
        },
      ],
    ],
    [
      "a bare URL over 56 chars shows host and path with the URL as title",
      "Read https://news.example/issues/48/offline-sync-three-months-in?utm_source=mail",
      [
        {
          _tag: "Paragraph",
          children: [
            { _tag: "Text", text: "Read " },
            {
              _tag: "Link",
              href: "https://news.example/issues/48/offline-sync-three-months-in?utm_source=mail",
              title: "https://news.example/issues/48/offline-sync-three-months-in?utm_source=mail",
              children: [{ _tag: "Text", text: "news.example/issues/48/offline-sync-…" }],
            },
          ],
        },
      ],
    ],
    [
      "a long mailto link keeps its full address",
      "<mailto:unsubscribe-weekly-digest-robin@lists.trailhead-weekly.example>",
      [
        {
          _tag: "Paragraph",
          children: [
            {
              _tag: "Link",
              href: "mailto:unsubscribe-weekly-digest-robin@lists.trailhead-weekly.example",
              title: null,
              children: [
                {
                  _tag: "Text",
                  text: "mailto:unsubscribe-weekly-digest-robin@lists.trailhead-weekly.example",
                },
              ],
            },
          ],
        },
      ],
    ],
    [
      "a short bare URL stays as written",
      "https://news.example/a",
      [
        {
          _tag: "Paragraph",
          children: [
            {
              _tag: "Link",
              href: "https://news.example/a",
              title: null,
              children: [{ _tag: "Text", text: "https://news.example/a" }],
            },
          ],
        },
      ],
    ],
    [
      "inline HTML is text, one leaf with the words around it",
      "prints <b>raw</b> tags",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "prints <b>raw</b> tags" }] }],
    ],
    [
      "block HTML is text",
      '<div style="x">hi</div>',
      [{ _tag: "Html", text: '<div style="x">hi</div>' }],
    ],
    [
      "entities and escapes are decoded",
      "Fish &amp; chips \\*not bold\\*",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "Fish & chips *not bold*" }] }],
    ],
    [
      "a soft break stays inside the text",
      "line one\nline two",
      [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "line one\nline two" }] }],
    ],
    [
      "a reference link resolves through its definition",
      "[docs][d]\n\n[d]: https://news.example/docs",
      [
        {
          _tag: "Paragraph",
          children: [
            {
              _tag: "Link",
              href: "https://news.example/docs",
              title: null,
              children: [{ _tag: "Text", text: "docs" }],
            },
          ],
        },
      ],
    ],
    [
      "a repeated reference definition keeps the first destination",
      "[docs][d]\n\n[d]: https://first.example/docs\n[d]: https://second.example/docs",
      [
        {
          _tag: "Paragraph",
          children: [
            {
              _tag: "Link",
              href: "https://first.example/docs",
              title: null,
              children: [{ _tag: "Text", text: "docs" }],
            },
          ],
        },
      ],
    ],
  ])("%s", (_, markdown, expected) => {
    expect(visible(markdown)).toEqual(expected);
  });

  it("keeps headings, lists, quotes, code, rules and tables", () => {
    expect(
      visible(
        "# Title\n\n- one\n- two\n\n> quoted\n\n```\ncode()\n```\n\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |",
      ),
    ).toEqual([
      { _tag: "Heading", depth: 1, children: [{ _tag: "Text", text: "Title" }] },
      {
        _tag: "List",
        ordered: false,
        start: null,
        items: [
          [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "one" }] }],
          [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "two" }] }],
        ],
      },
      {
        _tag: "Quote",
        children: [{ _tag: "Paragraph", children: [{ _tag: "Text", text: "quoted" }] }],
      },
      { _tag: "Code", text: "code()" },
      { _tag: "Rule" },
      {
        _tag: "Table",
        rows: [
          [[{ _tag: "Text", text: "a" }], [{ _tag: "Text", text: "b" }]],
          [[{ _tag: "Text", text: "1" }], [{ _tag: "Text", text: "2" }]],
        ],
      },
    ]);
  });
});

describe("plainText", () => {
  it("is the visible leaves in reading order, without URLs or image sources", () => {
    const markdown =
      "[![](https://cdn.example/b.png)](https://news.example/i)\n\n# Hi\n\n![Chart](https://cdn.example/c.png)\n\nSee [the primer](https://news.example/primer) and `run()`.";
    expect(leaves(visible(markdown))).toEqual([
      "Hi",
      "Chart",
      "See ",
      "the primer",
      " and ",
      "run()",
      ".",
    ]);
    expect(plainText(markdown)).not.toMatch(/https|cdn|png|primer\)/);
  });
});
