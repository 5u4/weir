import { DigestOutput } from "@weir/contract/Digest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const parseJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeOutput = Schema.decodeUnknownResult(DigestOutput);

export const lastJsonBlock = (stdout: string): Result.Result<unknown, string> => {
  for (const [, block = ""] of [...stdout.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].reverse()) {
    const parsed = parseJson(block);
    if (Result.isSuccess(parsed)) return Result.succeed(parsed.success);
  }
  const end = stdout.lastIndexOf("}");
  for (let start = stdout.lastIndexOf("{", end); end !== -1 && start !== -1; ) {
    const parsed = parseJson(stdout.slice(start, end + 1));
    if (Result.isSuccess(parsed)) return Result.succeed(parsed.success);
    start = start === 0 ? -1 : stdout.lastIndexOf("{", start - 1);
  }
  return Result.fail("no JSON block in output");
};

export const decode = (
  stdout: string,
  seqs: ReadonlyArray<number>,
): Result.Result<DigestOutput, string> =>
  lastJsonBlock(stdout).pipe(
    Result.flatMap((json) => Result.mapError(decodeOutput(json), (error) => error.message)),
    Result.flatMap((output) => {
      const items = new Set(seqs);
      const outside = output.topics.flatMap((topic) => topic.seqs).filter((seq) => !items.has(seq));
      if (outside.length > 0) {
        return Result.fail(
          `${outside.map((seq) => `#${seq}`).join(", ")} not among the items (${seqs.map((seq) => `#${seq}`).join(", ")})`,
        );
      }
      return Result.succeed(output);
    }),
  );
