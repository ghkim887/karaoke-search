import { createRequire } from 'node:module';

type SqliteModule = typeof import('node:sqlite');
export type SongDatabase = import('node:sqlite').DatabaseSync;
/** A prepared statement handle, shared by the unified write path. */
export type PreparedStatement = ReturnType<SongDatabase['prepare']>;

const require = createRequire(import.meta.url);

function sqlite(): SqliteModule {
  return require('node:sqlite') as SqliteModule;
}

const SONG_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)), crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT);
CREATE TABLE IF NOT EXISTS karaoke_numbers (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')), number TEXT, number_key TEXT, PRIMARY KEY (song_id, provider));
CREATE TABLE IF NOT EXISTS artist_aliases (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position));
CREATE TABLE IF NOT EXISTS search_texts (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), text_norm TEXT NOT NULL, text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (song_id, field, text_compact));
CREATE TABLE IF NOT EXISTS search_tokens (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram1', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias', 'title_hint', 'artist_hint')), weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (kind, token, song_id, field));
CREATE TABLE IF NOT EXISTS search_token_stats (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram1', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, df INTEGER NOT NULL, idf_scaled INTEGER NOT NULL, PRIMARY KEY (kind, token));
CREATE TABLE IF NOT EXISTS search_hints (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title', 'artist')), source TEXT NOT NULL, text_norm TEXT NOT NULL, text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')), PRIMARY KEY (song_id, field, source, text_compact));`;

const SONG_INDEX_SCHEMA_SQL = `CREATE INDEX IF NOT EXISTS idx_songs_sort_order ON songs(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_provider_number ON karaoke_numbers(provider, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_number ON karaoke_numbers(number, provider, song_id) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_number_key ON karaoke_numbers(number_key, provider, song_id) WHERE number_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_search_texts_compact ON search_texts(text_compact, song_id);
CREATE INDEX IF NOT EXISTS idx_search_texts_song ON search_texts(song_id);
CREATE INDEX IF NOT EXISTS idx_search_tokens_lookup ON search_tokens(kind, token, song_id);
CREATE INDEX IF NOT EXISTS idx_search_tokens_song ON search_tokens(song_id);`;

/**
 * The canonical schema for the self-hosted SQLite search database
 * (`createSongDatabase` / the worker's `sqlite:build` + `serve:node` path).
 * The schema started life on Cloudflare D1 (removed 2026-06-13); it now serves
 * the self-hosted SQLite search database.
 */
export const SONG_SCHEMA_SQL = `${SONG_TABLE_SCHEMA_SQL}
${SONG_INDEX_SCHEMA_SQL}`;

export function openSongDatabase(path: string): SongDatabase {
  return new (sqlite().DatabaseSync)(path);
}

export function createSongDatabase(db: SongDatabase): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SONG_TABLE_SCHEMA_SQL);
  ensureTableColumn(
    db,
    'songs',
    'artist_aliases_present',
    'ALTER TABLE songs ADD COLUMN artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1))',
  );
  ensureTableColumn(
    db,
    'karaoke_numbers',
    'number_key',
    'ALTER TABLE karaoke_numbers ADD COLUMN number_key TEXT',
  );
  ensureSearchTokensHintFields(db);
  db.exec(SONG_INDEX_SCHEMA_SQL);
}

/**
 * Upgrade a legacy database whose `search_tokens.field` CHECK predates the
 * search-hint fields. SQLite cannot widen a CHECK in place, but `search_tokens`
 * is fully derived and rebuilt on every {@link importSongs}, so dropping and
 * recreating it from the current schema loses nothing. The re-exec of
 * {@link SONG_TABLE_SCHEMA_SQL} recreates only the dropped table (the rest use
 * `IF NOT EXISTS`) and also backfills `search_hints` on older databases.
 */
function ensureSearchTokensHintFields(db: SongDatabase): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'search_tokens'`)
    .get() as { sql?: string } | undefined;
  if (
    row?.sql !== undefined &&
    (!row.sql.includes("'title_hint'") || !row.sql.includes("'gram1'"))
  ) {
    db.exec('DROP TABLE IF EXISTS search_tokens');
    db.exec(SONG_TABLE_SCHEMA_SQL);
  }
}

function ensureTableColumn(
  db: SongDatabase,
  tableName: string,
  columnName: string,
  alterSql: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as TableInfoRow[];
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(alterSql);
  }
}

interface TableInfoRow {
  name: string;
}
