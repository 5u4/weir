import { type Source, StreamDescriptor, SyncPage } from "@weir/contract/Source";
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
import { stripQuoted } from "./Body.ts";
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

const callSource = <A>(sourceId: string, call: () => Promise<A>) =>
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

const writePage = Effect.fnUntraced(function* (
  stream: StreamRow,
  page: SyncPage,
  tags: Tags,
  backfilling: boolean,
) {
  const written = yield* Write.writeItems(
    stream,
    page.upserts.map((item) => ({ ...item, bodyNew: item.bodyNew ?? stripQuoted(item.body) })),
  );
  const recompute = new Set<ConversationId>(
    yield* Write.softDeleteItems(stream.id, page.deletions),
  );
  const deleted = [...recompute];
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
  if (backfilling) yield* Write.advanceSeenSeq(written);
  yield* Write.saveCursor(stream.id, page.cursor, { backfilled: backfilling && !page.more });
  return [...new Set([...deleted, ...written.map(({ conversationId }) => conversationId)])];
});

export const syncStream = Effect.fnUntraced(function* (
  sourceId: string,
  source: Source,
  descriptor: StreamDescriptor,
  tags: Tags,
  onWritten: Written,
) {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* DateTime.now;
  let streamId = Option.getOrNull(yield* Read.streamId(sourceId, descriptor.id));
  let counts: SyncCounts = { upserts: 0, deletions: 0 };
  return yield* Effect.gen(function* () {
    const { stream, fromMeChanged } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const upserted = yield* Write.upsertStream(sourceId, descriptor);
        yield* recomputeTags(tags, upserted.fromMeChanged);
        return upserted;
      }),
    );
    if (fromMeChanged.length > 0) yield* onWritten(fromMeChanged);
    streamId = stream.id;
    let cursor = stream.cursor;
    let backfilling = stream.backfilledAt === null;
    let more = true;
    while (more) {
      const page = yield* callSource(sourceId, () => source.sync(descriptor.id, cursor)).pipe(
        Effect.flatMap(decodePage),
      );
      yield* onWritten(yield* sql.withTransaction(writePage(stream, page, tags, backfilling)));
      counts = {
        upserts: counts.upserts + page.upserts.length,
        deletions: counts.deletions + page.deletions.length,
      };
      cursor = page.cursor;
      backfilling = backfilling && page.more;
      more = page.more;
    }
    return counts;
  }).pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (streamId === null) return;
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
  yield* Effect.forEach(
    descriptors,
    (descriptor) =>
      syncStream(sourceId, source, descriptor, tags, onWritten).pipe(
        Effect.catch((error) =>
          Effect.logError(`sync of ${sourceId}/${descriptor.id} failed`, error),
        ),
      ),
    { discard: true },
  );
});
