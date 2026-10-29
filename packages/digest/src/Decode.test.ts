import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";
import { decode } from "./Decode.ts";

const answer = {
  headline: "客户同意周四验收",
  topics: [{ title: "周四验收", state: "open", body: "客户确认周四验收。", seqs: [3, 7] }],
};
const earlier = {
  headline: "草稿",
  topics: [{ title: "草稿", state: "fyi", body: "第一版。", seqs: [3] }],
};

const fenced = (value: unknown, info = "json") => `\`\`\`${info}\n${JSON.stringify(value)}\n\`\`\``;

const withTopics = (topics: ReadonlyArray<{ readonly seqs: ReadonlyArray<number> }>) =>
  JSON.stringify({
    headline: answer.headline,
    topics: topics.map(({ seqs }, index) => ({ ...answer.topics[0], title: `话题${index}`, seqs })),
  });

describe("decode", () => {
  it("decodes a valid answer to its headline and topics", () => {
    expect(decode(fenced(answer), [3, 7, 12])).toEqual(Result.succeed(answer));
  });

  it("takes the last fenced block over an earlier valid one", () => {
    expect(decode(`${fenced(earlier)}\nrevised:\n${fenced(answer)}`, [3, 7])).toEqual(
      Result.succeed(answer),
    );
  });

  it("takes the last fenced block that parses as JSON", () => {
    expect(decode(`${fenced(answer)}\n\`\`\`json\n{"headline":\n\`\`\``, [3, 7])).toEqual(
      Result.succeed(answer),
    );
  });

  it("tolerates prose around a fence with any info string", () => {
    expect(decode(`Here is the digest:\n${fenced(answer, "")}\nHope this helps.`, [3, 7])).toEqual(
      Result.succeed(answer),
    );
    expect(decode(`Sure.\n${fenced(answer, "jsonc")}\nDone.`, [3, 7])).toEqual(
      Result.succeed(answer),
    );
  });

  it("finds an unfenced trailing JSON object", () => {
    expect(decode(`The answer is ${JSON.stringify(answer)} as requested.`, [3, 7])).toEqual(
      Result.succeed(answer),
    );
  });

  it("fails on prose only", () => {
    expect(decode("I could not summarize these messages.", [3, 7])).toEqual(
      Result.fail("no JSON block in output"),
    );
  });

  it("rejects a seq outside the given items", () => {
    const result = decode(withTopics([{ seqs: [3, 9] }]), [3, 7]);
    expect(Result.isFailure(result) && result.failure).toContain("#9");
  });

  it("rejects a seq in two topics", () => {
    expect(Result.isFailure(decode(withTopics([{ seqs: [3] }, { seqs: [3, 7] }]), [3, 7]))).toBe(
      true,
    );
  });

  it("rejects two topics for a one-item range", () => {
    expect(Result.isFailure(decode(withTopics([{ seqs: [3] }, { seqs: [3] }]), [3]))).toBe(true);
  });

  it("rejects a headline over 40 CJK characters", () => {
    expect(
      Result.isSuccess(decode(JSON.stringify({ ...answer, headline: "验".repeat(40) }), [3, 7])),
    ).toBe(true);
    expect(
      Result.isFailure(decode(JSON.stringify({ ...answer, headline: "验".repeat(41) }), [3, 7])),
    ).toBe(true);
  });
});
