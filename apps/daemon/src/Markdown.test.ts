import { describe, expect, it } from "vitest";
import { hast, leaves, plainText } from "./Markdown.ts";

describe("plainText", () => {
  it("is the visible text leaves in reading order, without URLs or loaded image alts", () => {
    const markdown =
      "[![](https://cdn.example/b.png)](https://news.example/i)\n\n# Hi\n\n![Chart](https://cdn.example/c.png)\n\n![Old chart](http://cdn.example/o.png)\n\nSee [the primer](https://news.example/primer) and `run()`.";
    expect(leaves(hast(markdown))).toEqual([
      "Hi",
      "Old chart",
      "See ",
      "the primer",
      " and ",
      "run()",
      ".",
    ]);
    expect(plainText(markdown)).not.toMatch(/https|cdn|png|primer\)/);
  });
});
