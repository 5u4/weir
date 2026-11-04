import { DigestOutput, type Due } from "@weir/contract/Digest";
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

const listed = (seqs: ReadonlyArray<number>) => seqs.map((seq) => `#${seq}`).join(", ");

const dueError = (
  topic: DigestOutput["topics"][number],
  items: ReadonlySet<number>,
  carried: ReadonlyArray<Due>,
): string | null => {
  const due = topic.due;
  if (due === undefined) return null;
  const cited = `topic "${topic.title}" due ${due.date} cites #${due.seq}`;
  if (items.has(due.seq)) {
    return topic.seqs.includes(due.seq)
      ? null
      : `${cited}, which is not among its seqs (${listed(topic.seqs)})`;
  }
  if (carried.some(({ date, seq }) => date === due.date && seq === due.seq)) return null;
  const known = carried.map(({ date, seq }) => `${date} #${seq}`).join(", ");
  return `${cited}, which is neither among its seqs (${listed(topic.seqs)}) nor a due of a context digest (${known === "" ? "none" : known})`;
};

export const decode = (
  stdout: string,
  seqs: ReadonlyArray<number>,
  carried: ReadonlyArray<Due>,
): Result.Result<DigestOutput, string> =>
  lastJsonBlock(stdout).pipe(
    Result.flatMap((json) => Result.mapError(decodeOutput(json), (error) => error.message)),
    Result.flatMap((output) => {
      const items = new Set(seqs);
      const outside = output.topics.flatMap((topic) => topic.seqs).filter((seq) => !items.has(seq));
      if (outside.length > 0) {
        return Result.fail(`${listed(outside)} not among the items (${listed(seqs)})`);
      }
      const dues = output.topics.flatMap((topic) => dueError(topic, items, carried) ?? []);
      return dues.length > 0 ? Result.fail(dues.join("; ")) : Result.succeed(output);
    }),
  );
