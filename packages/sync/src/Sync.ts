import { Faces, type Source, StreamDescriptor, SyncPage } from "@weir/contract/Source";
import * as Read from "@weir/store/Read";
import type { ConversationId, StreamRow } from "@weir/store/Rows";
import * as Write from "@weir/store/Write";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { type Groups, joinThreads, regroupThreads } from "./Groups.ts";
import { appendItemTags, recomputeTags, type Tags } from "./Tags.ts";

export class SourceError extends Schema.TaggedError<SourceError>()("SourceError", {
  sourceId: Schema.String,
  message: Schema.String,
}) {}

export interface SyncCounts {
  readonly upserts: number;
  readonly deletions: number;
}

export type Written = (conversationIds: ReadonlyArray<ConversationId>) => Effect.Effect<void>;

const strict = { onExcessProperty: "error" } as const;
const decodeStreams = Schema.decodeUnknownEffect(Schema.Array(StreamDescriptor), strict);
const decodePage = Schema.decodeUnknownEffect(SyncPage, strict);
const decodeFaces = Schema.decodeUnknownEffect(Faces, strict);

const callSource = <A>(sourceId: string, call: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new SourceError({
        sourceId,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const errorMessage = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);

export type FaceSource = Source & { readonly faces: NonNullable<Source["faces"]> };

export const hasFaces = (source: Source): source is FaceSource =>
  typeof source.faces === "function";

export const lookupFaces = (
  sourceId: string,
  source: FaceSource,
  addresses: ReadonlyArray<string>,
) =>
  callSource(sourceId, (signal) => source.faces(addresses, signal)).pipe(
    Effect.flatMap((reply) =>
      decodeFaces(reply).pipe(
        Effect.mapError((failure) => new SourceError({ sourceId, message: failure.message })),
      ),
    ),
  );

const writePage = Effect.fnUntraced(function* (
  stream: StreamRow,
  page: SyncPage,
  tags: Tags,
  groups: Groups,
) {
  const deleted = yield* Write.softDeleteItems(stream.id, page.deletions);
  const removed = new Set(page.deletions);
  const upserts = page.upserts.filter(({ externalId }) => !removed.has(externalId));
  const priors = yield* Read.priorEvents(
    stream,
    upserts.flatMap(({ event }) => (event === undefined ? [] : [event])),
  );
  const drafted = upserts.flatMap((item) => {
    const draft = Write.draft(stream, item, priors, page.kind === "live");
    return draft === null ? [] : [draft];
  });
  const refreshed = yield* Write.refreshItems(drafted.filter(({ refresh }) => refresh !== null));
  const drafts = drafted.filter(({ refresh }) => refresh === null);
  const { keys, moved } = yield* joinThreads(stream, drafted, deleted.threads, groups);
  const written = yield* Write.writeItems(
    stream,
    drafts.map((draft) => {
      const thread = draft.threadId ?? draft.containerId;
      return { ...draft, key: keys.get(thread) ?? thread };
    }),
  );
  const recompute = new Set<ConversationId>([...moved, ...deleted.conversationIds, ...refreshed]);
  for (const { conversationId, previousConversationId } of written) {
    if (previousConversationId === null) continue;
    recompute.add(conversationId);
    recompute.add(previousConversationId);
  }
  yield* recomputeTags(tags, [...recompute]);
  yield* appendItemTags(
    tags,
    written
      .filter(
        ({ conversationId, previousConversationId }) =>
          previousConversationId === null && !recompute.has(conversationId),
      )
      .map(({ seq }) => seq),
  );
  if (page.kind === "backfill") {
    yield* Write.advanceSeenSeq(
      written.filter(({ inserted, conversationWasRead }) => inserted && conversationWasRead),
    );
    if (stream.kind === "event") {
      const fresh = yield* Read.eventOnly([
        ...new Set(
          written
            .filter(({ conversationWasNew }) => conversationWasNew)
            .map(({ conversationId }) => conversationId),
        ),
      ]);
      yield* Write.advanceClearedSeq([
        ...new Set([
          ...written
            .filter(({ conversationWasDone }) => conversationWasDone)
            .map(({ conversationId }) => conversationId),
          ...fresh,
        ]),
      ]);
    }
  }
  yield* Write.replaceOccurrences(stream.sourceId, page.occurrences ?? []);
  yield* Write.saveCursor(stream.id, page.cursor, page.backfill);
  return [...new Set([...recompute, ...written.map(({ conversationId }) => conversationId)])];
});

export const syncStream = Effect.fnUntraced(function* (
  sourceId: string,
  source: Source,
  descriptor: StreamDescriptor,
  tags: Tags,
  groups: Groups,
  onWritten: Written,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* DateTime.now;
  let streamId = Option.getOrNull(yield* Read.streamId(sourceId, descriptor.id));
  let counts: SyncCounts = { upserts: 0, deletions: 0 };
  return yield* Effect.gen(function* () {
    const { stream } = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const upserted = yield* Write.upsertStream(sourceId, descriptor);
          const regrouped =
            upserted.fromMeChanged.length > 0 && groups.length > 0
              ? yield* regroupThreads(
                  sourceId,
                  [
                    ...new Set(
                      (yield* Read.liveItems({ conversationIds: upserted.fromMeChanged })).map(
                        (item) => item.threadId ?? item.containerId,
                      ),
                    ),
                  ],
                  groups,
                )
              : [];
          const fromMeChanged = [...new Set([...upserted.fromMeChanged, ...regrouped])];
          yield* recomputeTags(tags, fromMeChanged);
          return { ...upserted, fromMeChanged };
        }),
      )
      .pipe(
        Effect.tap(({ fromMeChanged }) =>
          fromMeChanged.length > 0 ? onWritten(fromMeChanged) : Effect.void,
        ),
        Effect.uninterruptible,
      );
    streamId = stream.id;
    let cursor = stream.cursor;
    let more = true;
    while (more) {
      const page = yield* callSource(sourceId, (signal) =>
        source.sync(descriptor.id, cursor, signal),
      ).pipe(Effect.flatMap(decodePage));
      yield* sql
        .withTransaction(writePage(stream, page, tags, groups))
        .pipe(Effect.flatMap(onWritten), Effect.uninterruptible);
      counts = {
        upserts: counts.upserts + page.upserts.length,
        deletions: counts.deletions + page.deletions.length,
      };
      cursor = page.cursor;
      more = page.more;
    }
    return counts;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (streamId === null || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))) {
          return;
        }
        const finishedAt = yield* Clock.currentTimeMillis;
        const error = Exit.isFailure(exit) ? errorMessage(Cause.squash(exit.cause)) : null;
        yield* sql.withTransaction(
          Write.recordSyncRun({
            streamId,
            startedAt,
            ms: finishedAt - DateTime.toEpochMillis(startedAt),
            ...counts,
            error,
          }),
        );
      }),
    ),
  );
});

export const syncSource = Effect.fnUntraced(function* (
  sourceId: string,
  source: Source,
  tags: Tags,
  groups: Groups,
  onWritten: Written,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* DateTime.now;
  const descriptors = yield* callSource(sourceId, () => source.streams()).pipe(
    Effect.flatMap(decodeStreams),
    Effect.tapError((failure) =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis;
        yield* sql.withTransaction(
          Write.recordSourceFailure(sourceId, {
            startedAt,
            ms: finishedAt - DateTime.toEpochMillis(startedAt),
            upserts: 0,
            deletions: 0,
            error: errorMessage(failure),
          }),
        );
      }),
    ),
  );
  const failures = yield* Effect.forEach(descriptors, (descriptor) =>
    syncStream(sourceId, source, descriptor, tags, groups, onWritten).pipe(
      Effect.as(null),
      Effect.catch((error) =>
        Effect.logError(`sync of ${sourceId}/${descriptor.id} failed`, error).pipe(
          Effect.as(`${descriptor.id}: ${errorMessage(error)}`),
        ),
      ),
    ),
  );
  return failures.filter((failure) => failure !== null);
});
