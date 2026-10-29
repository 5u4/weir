import type { AiProfile, DigestConfig } from "@weir/contract/Config";
import type { InputItem, Trigger } from "@weir/contract/Digest";
import * as Read from "@weir/store/Read";
import type { ConversationId, DigestId, DigestRow, Seq } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as Prompt from "./Prompt.ts";
import { autoRange, chunks, manualRange, type Range, type Request } from "./Range.ts";
import * as Run from "./Run.ts";

export interface Settings {
  readonly ai: string;
  readonly profile: AiProfile;
  readonly digest: DigestConfig;
  readonly guide: string | null;
}

export interface Job {
  readonly conversationId: ConversationId;
  readonly range: Range;
  readonly trigger: Trigger;
}

export interface Queue {
  readonly running: ReadonlyArray<Job>;
  readonly waiting: number;
}

export class DigestNotFound extends Schema.TaggedError<DigestNotFound>()("DigestNotFound", {
  message: Schema.String,
}) {}

export class DigestRejected extends Schema.TaggedError<DigestRejected>()("DigestRejected", {
  message: Schema.String,
}) {}

export class DigestRunFailed extends Schema.TaggedError<DigestRunFailed>()("DigestRunFailed", {
  error: Schema.String,
  logPath: Schema.NullOr(Schema.String),
}) {}

export class DigestInterrupted extends Schema.TaggedError<DigestInterrupted>()(
  "DigestInterrupted",
  { message: Schema.String },
) {}

export type ManualError = DigestNotFound | DigestRejected | DigestRunFailed | DigestInterrupted;

export interface Digester {
  readonly auto: (conversationIds: ReadonlyArray<ConversationId>) => Effect.Effect<void>;
  readonly manual: (
    conversationId: ConversationId,
    request: Exclude<Request, { readonly _tag: "Redo" }>,
  ) => Effect.Effect<ReadonlyArray<DigestRow>, ManualError>;
  readonly redo: (id: DigestId) => Effect.Effect<ReadonlyArray<DigestRow>, ManualError>;
  readonly queue: Effect.Effect<Queue>;
}

interface Plan extends Job {
  readonly chunks: ReadonlyArray<Range>;
  readonly replaces: DigestRow | null;
}

type Services =
  | SqlClient.SqlClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem;

export const make = Effect.fnUntraced(function* (settings: Settings, logDir: string) {
  const scope = yield* Scope.Scope;
  const services: Context.Context<Services> = yield* Effect.context<Services>();
  const sql = yield* SqlClient.SqlClient;
  const permits = yield* Semaphore.make(settings.profile.concurrency);
  const locks = new Map<ConversationId, Semaphore.Semaphore>();
  const queuedAuto = new Set<ConversationId>();
  const failedAuto = new Map<ConversationId, Seq>();
  const queue = yield* Ref.make<ReadonlyMap<number, Job & { readonly running: boolean }>>(
    new Map(),
  );
  let nextJob = 0;

  const serially = <A, E, R>(conversationId: ConversationId, effect: Effect.Effect<A, E, R>) => {
    const lock = locks.get(conversationId) ?? Semaphore.makeUnsafe(1);
    locks.set(conversationId, lock);
    return lock.withPermits(1)(effect);
  };

  const runChunk = Effect.fnUntraced(function* (plan: Plan, chunk: Range) {
    const detail = yield* Read.getConversation(plan.conversationId);
    if (Option.isNone(detail)) return Option.none<DigestRow>();
    const { conversation, items } = detail.value;
    const digests = yield* Read.digests([plan.conversationId]);
    const digestInput = Prompt.input({
      language: settings.digest.language,
      guide: settings.guide,
      conversation: {
        id: conversation.id,
        source: conversation.sourceId,
        title: conversation.title,
      },
      items: items.map(
        (item): InputItem => ({
          seq: item.seq,
          occurred_at: DateTime.formatIso(item.occurredAt),
          from: { name: item.fromName, address: item.fromAddress },
          from_me: item.fromMe,
          title: item.title,
          body_new: item.bodyNew,
        }),
      ),
      digests: digests.filter(({ id }) => id !== plan.replaces?.id),
      range: chunk,
      context: settings.digest.context,
      maxInput: settings.digest.max_input,
    });
    if (digestInput.items.length === 0) return Option.none<DigestRow>();
    const startedAt = yield* DateTime.now;
    const run = {
      conversationId: plan.conversationId,
      fromSeq: chunk.fromSeq,
      toSeq: chunk.toSeq,
      trigger: plan.trigger,
      ai: settings.ai,
      startedAt,
    };
    const elapsed = Effect.map(
      Clock.currentTimeMillis,
      (now) => now - DateTime.toEpochMillis(startedAt),
    );
    const output = yield* Run.generate(settings.profile, digestInput).pipe(
      Effect.catchTag("AiFailed", (failed) =>
        Effect.gen(function* () {
          const logPath = yield* Run.writeLog(
            logDir,
            plan.conversationId,
            chunk,
            startedAt,
            failed.attempts,
          ).pipe(
            Effect.tapError((error) => Effect.logError("cannot write the digest log", error)),
            Effect.orElseSucceed(() => null),
          );
          yield* Write.recordDigestRun({
            ...run,
            ms: yield* elapsed,
            ok: false,
            error: failed.error,
            logPath,
          });
          if (plan.trigger === "auto") failedAuto.set(plan.conversationId, plan.range.toSeq);
          return yield* new DigestRunFailed({ error: failed.error, logPath });
        }),
      ),
    );
    const written = yield* Write.writeDigest(
      {
        conversationId: plan.conversationId,
        fromSeq: chunk.fromSeq,
        toSeq: chunk.toSeq,
        headline: output.headline,
        topics: output.topics,
        trigger: plan.replaces?.trigger ?? plan.trigger,
        aiProfile: settings.ai,
        createdAt: yield* DateTime.now,
      },
      { ...run, ms: yield* elapsed, ok: true, error: null, logPath: null },
      plan.replaces?.id ?? null,
    ).pipe(Effect.uninterruptible);
    return Option.some(written);
  });

  const runPlan = Effect.fnUntraced(function* (plan: Plan) {
    const id = nextJob++;
    const job: Job = {
      conversationId: plan.conversationId,
      range: plan.range,
      trigger: plan.trigger,
    };
    yield* Ref.update(queue, (jobs) => new Map(jobs).set(id, { ...job, running: false }));
    return yield* permits
      .withPermits(1)(
        Effect.gen(function* () {
          yield* Ref.update(queue, (jobs) => new Map(jobs).set(id, { ...job, running: true }));
          const written: Array<DigestRow> = [];
          for (const chunk of plan.chunks) {
            const result = yield* runChunk(plan, chunk);
            if (Option.isSome(result)) written.push(result.value);
          }
          return written;
        }),
      )
      .pipe(
        Effect.ensuring(
          Ref.update(queue, (jobs) => {
            const next = new Map(jobs);
            next.delete(id);
            return next;
          }),
        ),
      );
  });

  const autoCheck = (conversationId: ConversationId) =>
    serially(
      conversationId,
      Effect.gen(function* () {
        queuedAuto.delete(conversationId);
        const since = yield* Read.aiSince(conversationId);
        if (Option.isNone(since)) return;
        const items = yield* Read.itemsLite(conversationId);
        const spans = yield* Read.digests([conversationId]);
        const range = autoRange(items, spans, since.value, settings.digest.threshold);
        if (range === null || range.toSeq <= (failedAuto.get(conversationId) ?? 0)) return;
        yield* runPlan({
          conversationId,
          range,
          trigger: "auto",
          chunks: chunks(items, range, settings.digest.max_input),
          replaces: null,
        });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError(`auto digest of conversation ${conversationId} failed`, cause),
      ),
    );

  const auto = (conversationIds: ReadonlyArray<ConversationId>) =>
    Effect.forEach(
      conversationIds.filter((conversationId) => !queuedAuto.has(conversationId)),
      (conversationId) => {
        queuedAuto.add(conversationId);
        return Effect.forkIn(Effect.provideContext(autoCheck(conversationId), services), scope);
      },
      { discard: true },
    );

  const submit = (
    target: Effect.Effect<
      ConversationId,
      DigestNotFound | SqlError.SqlError | Schema.SchemaError,
      SqlClient.SqlClient
    >,
    request: Request,
  ) =>
    Effect.gen(function* () {
      const conversationId = yield* target;
      const plan = serially(
        conversationId,
        Effect.gen(function* () {
          const items = yield* Read.itemsLite(conversationId);
          const spans = yield* Read.digests([conversationId]);
          const range = manualRange(items, spans, request, settings.digest.max_input);
          if (Result.isFailure(range)) return yield* new DigestRejected({ message: range.failure });
          const replaces =
            request._tag === "Redo" ? (spans.find(({ id }) => id === request.id) ?? null) : null;
          return yield* runPlan({
            conversationId,
            range: range.success,
            trigger: "manual",
            chunks:
              replaces === null
                ? chunks(items, range.success, settings.digest.max_input)
                : [range.success],
            replaces,
          });
        }),
      );
      const exit = yield* Fiber.await(
        yield* Effect.forkIn(Effect.provideContext(plan, services), scope),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return yield* new DigestInterrupted({
          message: "the digest was interrupted by a reload or shutdown; try again",
        });
      }
      return yield* Effect.failCause(exit.cause);
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchTag(["SqlError", "SchemaError"], Effect.die),
    );

  return {
    auto,
    manual: (conversationId, request) =>
      submit(
        Effect.flatMap(Read.conversation(conversationId), (found) =>
          Option.isNone(found)
            ? Effect.fail(new DigestNotFound({ message: `no conversation ${conversationId}` }))
            : Effect.succeed(conversationId),
        ),
        request,
      ),
    redo: (id) =>
      submit(
        Effect.flatMap(Read.digest(id), (found) =>
          Option.isNone(found)
            ? Effect.fail(new DigestNotFound({ message: `no digest ${id}` }))
            : Effect.succeed(found.value.conversationId),
        ),
        { _tag: "Redo", id },
      ),
    queue: Effect.map(Ref.get(queue), (jobs) => {
      const all = [...jobs.values()];
      return {
        running: all
          .filter(({ running }) => running)
          .map(({ conversationId, range, trigger }) => ({ conversationId, range, trigger })),
        waiting: new Set(all.filter(({ running }) => !running).map((job) => job.conversationId))
          .size,
      };
    }),
  } satisfies Digester;
});
