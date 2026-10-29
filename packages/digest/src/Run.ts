import { tmpdir } from "node:os";
import type { AiProfile } from "@weir/contract/Config";
import type { DigestInput, DigestOutput } from "@weir/contract/Digest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { decode } from "./Decode.ts";
import { render } from "./Prompt.ts";
import type { Range } from "./Range.ts";

export const maxAttempts = 3;

export const Attempt = Schema.Struct({
  prompt: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
  error: Schema.NullOr(Schema.String),
  ms: Schema.Int,
});
export type Attempt = typeof Attempt.Type;

export class AiFailed extends Schema.TaggedError<AiFailed>()("AiFailed", {
  error: Schema.String,
  attempts: Schema.Array(Attempt),
}) {}

const call = (profile: AiProfile, prompt: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [command, ...args] = profile.command;
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd: tmpdir(),
        stdin: Stream.make(new TextEncoder().encode(prompt)),
        forceKillAfter: Duration.seconds(2),
      }),
    );
    return yield* Effect.all(
      {
        stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
        stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
        exitCode: handle.exitCode,
      },
      { concurrency: "unbounded" },
    );
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(profile.timeout),
    Effect.map(
      Option.match({
        onNone: () => ({
          stdout: "",
          stderr: "",
          failure: `timed out after ${Duration.toMillis(profile.timeout)}ms`,
        }),
        onSome: ({ stdout, stderr, exitCode }) => ({
          stdout,
          stderr,
          failure:
            exitCode === 0
              ? null
              : `exit ${exitCode}${stderr.trim() === "" ? "" : `: ${stderr.trim().slice(-200)}`}`,
        }),
      }),
    ),
    Effect.catchTag("PlatformError", (error) =>
      Effect.succeed({ stdout: "", stderr: "", failure: error.message }),
    ),
  );

export const generate = Effect.fnUntraced(function* (profile: AiProfile, digestInput: DigestInput) {
  const seqs = digestInput.items.map(({ seq }) => seq);
  const attempts: Array<Attempt> = [];
  let error: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt = render(digestInput, error);
    const startedAt = yield* Clock.currentTimeMillis;
    const { stdout, stderr, failure } = yield* call(profile, prompt);
    const decoded: Result.Result<DigestOutput, string> =
      failure === null ? decode(stdout, seqs) : Result.fail(failure);
    error = Result.isFailure(decoded) ? `attempt ${attempt}: ${decoded.failure}` : null;
    attempts.push({
      prompt,
      stdout,
      stderr,
      error,
      ms: (yield* Clock.currentTimeMillis) - startedAt,
    });
    if (Result.isSuccess(decoded)) return decoded.success;
  }
  return yield* new AiFailed({ error: error ?? "no attempt ran", attempts });
});

export const writeLog = Effect.fnUntraced(function* (
  dir: string,
  conversationId: number,
  range: Range,
  startedAt: DateTime.Utc,
  attempts: ReadonlyArray<Attempt>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stamp = DateTime.formatIso(startedAt).replace(/[-:.]/g, "");
  const path = `${dir}/${conversationId}-${range.fromSeq}-${range.toSeq}-${stamp}.log`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    path,
    attempts
      .map((attempt, index) =>
        [
          `===== attempt ${index + 1}: ${attempt.error ?? "ok"} (${attempt.ms}ms)`,
          "----- prompt",
          attempt.prompt,
          "----- stdout",
          attempt.stdout,
          "----- stderr",
          attempt.stderr,
        ].join("\n"),
      )
      .join("\n\n"),
  );
  return path;
});
