import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE stream (
    id INTEGER PRIMARY KEY,
    source_id TEXT,
    external_id TEXT,
    kind TEXT,
    name TEXT,
    open_label TEXT,
    me TEXT,
    cursor TEXT,
    backfilled_at TEXT,
    last_sync_at TEXT,
    last_error TEXT,
    UNIQUE (source_id, external_id)
  )`;
  yield* sql`CREATE TABLE item (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id INTEGER,
    external_id TEXT,
    kind TEXT,
    conversation_id INTEGER,
    thread_id TEXT,
    container_id TEXT,
    container_name TEXT,
    occurred_at TEXT,
    synced_at TEXT,
    title TEXT,
    from_name TEXT,
    from_address TEXT,
    from_me INTEGER,
    body TEXT,
    body_new TEXT,
    link TEXT,
    raw TEXT,
    deleted_at TEXT,
    UNIQUE (stream_id, external_id)
  )`;
  yield* sql`CREATE INDEX item_conversation_id ON item (conversation_id)`;
  yield* sql`CREATE INDEX item_thread ON item (coalesce(thread_id, container_id))`;
  yield* sql`CREATE TABLE conversation (
    id INTEGER PRIMARY KEY,
    source_id TEXT,
    key TEXT,
    title TEXT,
    first_at TEXT,
    last_at TEXT,
    last_seq INTEGER,
    UNIQUE (source_id, key)
  )`;
  yield* sql`CREATE TABLE conversation_tag (
    conversation_id INTEGER,
    tag TEXT,
    PRIMARY KEY (conversation_id, tag)
  )`;
  yield* sql`CREATE TABLE conversation_state (
    conversation_id INTEGER PRIMARY KEY,
    seen_seq INTEGER,
    cleared_seq INTEGER,
    muted INTEGER
  )`;
  yield* sql`CREATE TABLE tag_state (
    name TEXT PRIMARY KEY,
    ai_since TEXT
  )`;
  yield* sql`CREATE TABLE sync_run (
    id INTEGER PRIMARY KEY,
    stream_id INTEGER,
    started_at TEXT,
    ms INTEGER,
    upserts INTEGER,
    deletions INTEGER,
    error TEXT
  )`;
  yield* sql`CREATE INDEX sync_run_stream_id ON sync_run (stream_id)`;
  yield* sql`CREATE TABLE digest (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER,
    from_seq INTEGER,
    to_seq INTEGER,
    headline TEXT,
    topics TEXT,
    "trigger" TEXT,
    ai_profile TEXT,
    created_at TEXT
  )`;
  yield* sql`CREATE INDEX digest_conversation_range
    ON digest (conversation_id, from_seq DESC, id DESC)`;
  yield* sql`CREATE TABLE digest_run (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER,
    from_seq INTEGER,
    to_seq INTEGER,
    "trigger" TEXT,
    ai TEXT,
    started_at TEXT,
    ms INTEGER,
    ok INTEGER,
    error TEXT,
    log_path TEXT
  )`;
  yield* sql`CREATE VIRTUAL TABLE search_fts USING fts5(
    text,
    conversation_id UNINDEXED,
    item_seq UNINDEXED,
    digest_id UNINDEXED,
    tokenize = 'trigram case_sensitive 0'
  )`;
});
