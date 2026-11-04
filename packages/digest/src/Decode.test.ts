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
    expect(decode(fenced(answer), [3, 7, 12], [])).toEqual(Result.succeed(answer));
  });

  it("takes the last fenced block over an earlier valid one", () => {
    expect(decode(`${fenced(earlier)}\nrevised:\n${fenced(answer)}`, [3, 7], [])).toEqual(
      Result.succeed(answer),
    );
  });

  it("takes the last fenced block that parses as JSON", () => {
    expect(decode(`${fenced(answer)}\n\`\`\`json\n{"headline":\n\`\`\``, [3, 7], [])).toEqual(
      Result.succeed(answer),
    );
  });

  it("tolerates prose around a fence with any info string", () => {
    expect(
      decode(`Here is the digest:\n${fenced(answer, "")}\nHope this helps.`, [3, 7], []),
    ).toEqual(Result.succeed(answer));
    expect(decode(`Sure.\n${fenced(answer, "jsonc")}\nDone.`, [3, 7], [])).toEqual(
      Result.succeed(answer),
    );
  });

  it("finds an unfenced trailing JSON object", () => {
    expect(decode(`The answer is ${JSON.stringify(answer)} as requested.`, [3, 7], [])).toEqual(
      Result.succeed(answer),
    );
  });

  it("fails on prose only", () => {
    expect(decode("I could not summarize these messages.", [3, 7], [])).toEqual(
      Result.fail("no JSON block in output"),
    );
  });

  it("rejects a seq outside the given items", () => {
    const result = decode(withTopics([{ seqs: [3, 9] }]), [3, 7], []);
    expect(Result.isFailure(result) && result.failure).toContain("#9");
  });

  it("rejects a seq in two topics", () => {
    expect(
      Result.isFailure(decode(withTopics([{ seqs: [3] }, { seqs: [3, 7] }]), [3, 7], [])),
    ).toBe(true);
  });

  it("rejects two topics for a one-item range", () => {
    expect(Result.isFailure(decode(withTopics([{ seqs: [3] }, { seqs: [3] }]), [3], []))).toBe(
      true,
    );
  });

  it("rejects a headline over 40 CJK characters", () => {
    expect(
      Result.isSuccess(
        decode(JSON.stringify({ ...answer, headline: "验".repeat(40) }), [3, 7], []),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        decode(JSON.stringify({ ...answer, headline: "验".repeat(41) }), [3, 7], []),
      ),
    ).toBe(true);
  });
});

describe("decode due", () => {
  const carriedDue = { date: "2026-10-23", seq: 2 };
  const carried = [carriedDue];
  const withDue = (due: { readonly date: string; readonly seq: number }, state = "open") => ({
    headline: answer.headline,
    topics: [{ ...answer.topics[0], state, due }],
  });
  const failure = (due: { readonly date: string; readonly seq: number }, state = "open") => {
    const result = decode(fenced(withDue(due, state)), [3, 7, 12], carried);
    return Result.isFailure(result) ? result.failure : null;
  };

  it("accepts a due carried unchanged from a context digest", () => {
    expect(decode(fenced(withDue(carriedDue)), [3, 7], carried)).toEqual(
      Result.succeed(withDue(carriedDue)),
    );
  });

  it("accepts a due citing one of its topic's seqs", () => {
    expect(decode(fenced(withDue({ date: "2026-10-30", seq: 7 })), [3, 7], carried)).toEqual(
      Result.succeed(withDue({ date: "2026-10-30", seq: 7 })),
    );
  });

  it("rejects a carried due with an altered date", () => {
    expect(failure({ date: "2026-10-24", seq: 2 })).toContain("nor a due of a context digest");
  });

  it("rejects a carried due with an altered seq", () => {
    expect(failure({ date: "2026-10-23", seq: 1 })).toContain("nor a due of a context digest");
  });

  it("rejects a due citing an unknown seq outside the items", () => {
    expect(failure({ date: "2026-10-30", seq: 20 })).toContain("cites #20");
  });

  it("rejects a due on a resolved topic", () => {
    expect(failure({ date: "2026-10-30", seq: 7 }, "resolved")).toContain(
      "a resolved topic has no due",
    );
  });

  it("rejects a due citing an item outside its topic", () => {
    expect(failure({ date: "2026-10-30", seq: 12 })).toContain("not among its seqs (#3, #7)");
  });
});
