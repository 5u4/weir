import { groupKeyPrefix } from "@weir/contract/Config";
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
    last_ok_at TEXT,
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
    from_verified INTEGER,
    format TEXT,
    body_new TEXT,
    text TEXT,
    text_new TEXT,
    link TEXT,
    raw TEXT,
    deleted_at TEXT,
    UNIQUE (stream_id, external_id)
  )`;
  yield* sql`CREATE INDEX item_conversation_id ON item (conversation_id)`;
  yield* sql`CREATE INDEX item_thread ON item (coalesce(thread_id, container_id))`;
  yield* sql`CREATE TABLE event_detail (
    item_seq INTEGER PRIMARY KEY REFERENCES item (seq),
    event_id TEXT,
    series_id TEXT,
    recurring INTEGER,
    start_at TEXT,
    end_at TEXT,
    start_utc TEXT,
    end_utc TEXT,
    all_day INTEGER,
    time_zone TEXT,
    location TEXT,
    attendees TEXT,
    status TEXT CHECK (status IN ('confirmed', 'cancelled')),
    change TEXT
  )`;
  yield* sql`CREATE INDEX event_detail_event_id ON event_detail (event_id, item_seq)`;
  yield* sql`CREATE TABLE event_occurrence (
    source_id TEXT,
    series_id TEXT,
    event_id TEXT,
    start_at TEXT,
    end_at TEXT,
    start_utc TEXT,
    end_utc TEXT,
    all_day INTEGER,
    status TEXT CHECK (status IN ('confirmed', 'cancelled')),
    PRIMARY KEY (source_id, series_id, event_id)
  )`;
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
    muted INTEGER,
    plan_kind TEXT CHECK (plan_kind IN ('tray', 'day', 'slot')),
    plan_date TEXT,
    plan_start INTEGER,
    plan_minutes INTEGER,
    planned_at TEXT,
    due_kind TEXT CHECK (due_kind IN ('date', 'cleared')),
    due_date TEXT,
    CHECK (CASE plan_kind
      WHEN 'tray' THEN plan_date IS NULL AND plan_start IS NULL AND plan_minutes IS NULL
        AND planned_at IS NOT NULL
      WHEN 'day' THEN plan_date IS NOT NULL AND plan_start IS NULL AND plan_minutes IS NULL
        AND planned_at IS NOT NULL
      WHEN 'slot' THEN plan_date IS NOT NULL AND plan_start BETWEEN 0 AND 1439
        AND plan_minutes > 0 AND planned_at IS NOT NULL
      ELSE plan_date IS NULL AND plan_start IS NULL AND plan_minutes IS NULL AND planned_at IS NULL
    END),
    CHECK (CASE due_kind WHEN 'date' THEN due_date IS NOT NULL ELSE due_date IS NULL END)
  )`;
  yield* sql`CREATE TABLE ai_state (
    kind TEXT,
    name TEXT,
    ai_since TEXT,
    PRIMARY KEY (kind, name)
  )`;
  yield* sql`CREATE VIEW conversation_ai AS
    SELECT conversation_tag.conversation_id, ai_state.kind, ai_state.name, ai_state.ai_since
      FROM conversation_tag
      JOIN ai_state ON ai_state.kind = 'tag' AND ai_state.name = conversation_tag.tag
    UNION ALL
    SELECT conversation.id, ai_state.kind, ai_state.name, ai_state.ai_since
      FROM ai_state
      JOIN conversation ON conversation.key = ${sql.literal(`'${groupKeyPrefix}'`)} || ai_state.name
      WHERE ai_state.kind = 'group'
        AND EXISTS (SELECT 1 FROM item WHERE item.conversation_id = conversation.id AND item.deleted_at IS NULL)`;
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
  yield* sql`CREATE TABLE face_blob (
    hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes BLOB NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE face (
    source_id TEXT NOT NULL,
    address TEXT NOT NULL,
    hash TEXT,
    kind TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (source_id, address)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX face_hash ON face (hash) WHERE hash IS NOT NULL`;
});
