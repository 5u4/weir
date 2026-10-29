import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { DigestOutput } from "./Digest.ts";

const decode = Schema.decodeUnknownSync(DigestOutput);

const topic = { title: "周四验收", state: "open", body: "客户确认周四验收。", seqs: [1, 2] };
const output = { headline: "客户同意周四验收", topics: [topic] };

const han = (count: number) => "验".repeat(count);
const latin = (count: number) => "a".repeat(count);

describe("DigestOutput", () => {
  it("trims text fields", () => {
    expect(
      decode({ headline: "  headline \n", topics: [{ ...topic, title: " t ", body: "\tb " }] }),
    ).toEqual({ headline: "headline", topics: [{ ...topic, title: "t", body: "b" }] });
  });

  it.each([
    ["headline", ""],
    ["headline", "   "],
    ["title", " "],
    ["body", "\n"],
  ])("rejects a blank %s", (field, value) => {
    const candidate =
      field === "headline"
        ? { ...output, headline: value }
        : { ...output, topics: [{ ...topic, [field]: value }] };
    expect(() => decode(candidate)).toThrow();
  });

  it.each([
    ["headline", han(40), true],
    ["headline", han(41), false],
    ["headline", `${han(40)}${latin(30)}`, true],
    ["headline", latin(70), true],
    ["headline", latin(71), false],
    ["headline", ` ${latin(70)} `, true],
    ["headline", "𠀀".repeat(40), true],
    ["headline", "😀".repeat(70), true],
    ["headline", "😀".repeat(71), false],
    ["title", han(16), true],
    ["title", han(17), false],
    ["title", latin(40), true],
    ["title", latin(41), false],
    ["body", han(80), true],
    ["body", han(81), false],
    ["body", latin(160), true],
    ["body", latin(161), false],
  ])("%s %#: accepted = %s", (field, value, accepted) => {
    const candidate =
      field === "headline"
        ? { ...output, headline: value }
        : { ...output, topics: [{ ...topic, [field]: value }] };
    if (accepted) expect(() => decode(candidate)).not.toThrow();
    else expect(() => decode(candidate)).toThrow();
  });

  it.each([
    [0, false],
    [1, true],
    [4, true],
    [5, false],
  ])("%i topics: accepted = %s", (count, accepted) => {
    const candidate = {
      ...output,
      topics: Array.from({ length: count }, (_, index) => ({ ...topic, seqs: [index + 1] })),
    };
    if (accepted) expect(() => decode(candidate)).not.toThrow();
    else expect(() => decode(candidate)).toThrow();
  });

  it.each([
    [[3], true],
    [[1, 2, 9], true],
    [[], false],
    [[2, 2], false],
    [[1, 3, 2], false],
    [[1.5], false],
  ])("seqs %j: accepted = %s", (seqs, accepted) => {
    const candidate = { ...output, topics: [{ ...topic, seqs }] };
    if (accepted) expect(() => decode(candidate)).not.toThrow();
    else expect(() => decode(candidate)).toThrow();
  });

  it.each([
    [[[1, 2], [3]], true],
    [
      [
        [1, 2],
        [2, 3],
      ],
      false,
    ],
  ])("topic seqs %j: accepted = %s", (topicSeqs, accepted) => {
    const candidate = { ...output, topics: topicSeqs.map((seqs) => ({ ...topic, seqs })) };
    if (accepted) expect(() => decode(candidate)).not.toThrow();
    else expect(() => decode(candidate)).toThrow();
  });
});
