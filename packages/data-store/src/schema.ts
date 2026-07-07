import { createRequire } from 'node:module';

type SqliteModule = typeof import('node:sqlite');
export type SongDatabase = import('node:sqlite').DatabaseSync;
/** A prepared statement handle, shared by the unified write path. */
export type PreparedStatement = ReturnType<SongDatabase['prepare']>;

const require = createRequire(import.meta.url);

function sqlite(): SqliteModule {
  return require('node:sqlite') as SqliteModule;
}

const SONG_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)), crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT, title_ruby TEXT);
CREATE TABLE IF NOT EXISTS karaoke_numbers (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')), number TEXT, number_key TEXT, PRIMARY KEY (song_id, provider)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS artist_aliases (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_texts (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (song_id, field, text_compact)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_tokens (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram1', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias', 'title_hint', 'artist_hint', 'title_ruby', 'title_ruby_romaji', 'title_ruby_hangul')), weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (kind, token, song_id, field)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_token_stats (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram1', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, df INTEGER NOT NULL, idf_scaled INTEGER NOT NULL, PRIMARY KEY (kind, token)) WITHOUT ROWID;`;

const SONG_INDEX_SCHEMA_SQL = `CREATE INDEX IF NOT EXISTS idx_songs_sort_order ON songs(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_provider_number ON karaoke_numbers(provider, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_number ON karaoke_numbers(number, provider, song_id) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_number_key ON karaoke_numbers(number_key, provider, song_id) WHERE number_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_search_texts_compact ON search_texts(text_compact, song_id);`;

/**
 * Legacy indexes this schema no longer creates but that older databases may
 * still carry. `createSongDatabase` drops each so a database opened by current
 * code converges on the canonical schema (and reclaims the space on its next
 * VACUUM) regardless of which build wrote it.
 */
const SONG_LEGACY_INDEX_DROP_SQL = 'DROP INDEX IF EXISTS idx_search_tokens_song;';

/**
 * The canonical schema for the self-hosted SQLite search database
 * (`createSongDatabase` / the worker's `sqlite:build` + `serve:node` path).
 * The schema started life on Cloudflare D1 (removed 2026-06-13); it now serves
 * the self-hosted SQLite search database.
 *
 * Physical layout: every derived/child table (`karaoke_numbers`,
 * `artist_aliases`, `search_texts`, `search_tokens`, `search_token_stats`) is
 * `WITHOUT ROWID`. Each has a narrow natural composite key
 * and no autoincrement identity, so clustering rows on the primary key drops
 * the implicit `rowid` plus the separate PK b-tree that a rowid table would
 * keep — the dominant `search_tokens`/`search_texts` tables stop paying for
 * that duplicate storage. `songs` keeps its rowid (wide rows, single TEXT key).
 *
 * No `idx_search_tokens_lookup(kind, token, song_id)` or
 * `idx_search_texts_song(song_id)`: both were left-prefixes of their table's
 * primary key (`(kind, token, song_id, field)` and `(song_id, field,
 * text_compact)`), so the PK already serves every lookup they covered.
 *
 * No `idx_search_tokens_song(song_id)` either (removed 2026-07, I4): it was
 * NOT a PK prefix (the `search_tokens` PK leads with `kind`), but the only
 * consumers were the delta patcher's per-song token sweeps, and it was the
 * single largest serving-artifact object (~41% of the DB, dominating the
 * `search_tokens` table it hung off). Serving search, full import, and df
 * recalculation all read via the PK `(kind, token, …)` prefix and never touched
 * it. The delta patcher now sweeps set-based over all touched songs in one pass
 * (`collectTokenKeysForSongs` / `deleteSearchTokensForSongs`), which is faster
 * than the old per-song loop even without the index and needs no `song_id`
 * index at all — so the whole 41% is reclaimed with no serving regression.
 */
export const SONG_SCHEMA_SQL = `${SONG_TABLE_SCHEMA_SQL}
${SONG_INDEX_SCHEMA_SQL}`;

export function openSongDatabase(path: string): SongDatabase {
  return new (sqlite().DatabaseSync)(path);
}

export function createSongDatabase(db: SongDatabase): void {
  db.exec('PRAGMA foreign_keys = ON;');
  // `CREATE TABLE IF NOT EXISTS` only materializes the `WITHOUT ROWID` layout on
  // a fresh database; a legacy rowid database opened by this code keeps its
  // existing rowid tables (the DDL is a no-op on tables that already exist), and
  // the import/delta-patch paths that follow issue only DML, so they stay
  // correct on either layout. `ALTER TABLE ... ADD COLUMN` below is valid on
  // rowid and WITHOUT ROWID tables alike.
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
  ensureTableColumn(db, 'songs', 'title_ruby', 'ALTER TABLE songs ADD COLUMN title_ruby TEXT');
  // Reading fields (R4) are token-only, so only `search_tokens` gains them.
  ensureSearchTableFields(db, 'search_tokens', "'title_ruby'");
  ensureSearchTokensHintFields(db);
  // Retire dead schema on legacy databases (2026-07-08): the search-only
  // `search_hints` table and the `search_texts.text_norm` column were written
  // but never read at serve/export/rebuild (recall materializes through
  // `search_tokens`). Both are fully derived and rebuilt on every import, so
  // dropping them here loses no durable data and lets a delta patch on an
  // older served DB avoid the removed NOT-NULL `text_norm` column.
  db.exec('DROP TABLE IF EXISTS search_hints');
  ensureSearchTextsNoTextNorm(db);
  db.exec(SONG_INDEX_SCHEMA_SQL);
  db.exec(SONG_LEGACY_INDEX_DROP_SQL);
}

/**
 * Widen a fully-derived search table's `field` CHECK to a newer field set.
 * SQLite cannot ALTER a CHECK in place, but `search_texts`/`search_tokens` are
 * rebuilt on every {@link importSongs} (and cleared per-song by the delta
 * patcher), so dropping and recreating one from the current schema loses no
 * durable data. `marker` is a quoted field literal (e.g. `"'title_ruby'"`) that
 * a current-schema table's DDL contains and a legacy one does not. The re-exec
 * of {@link SONG_TABLE_SCHEMA_SQL} recreates only the dropped table (the rest
 * use `IF NOT EXISTS`).
 */
function ensureSearchTableFields(db: SongDatabase, tableName: string, marker: string): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: string } | undefined;
  if (row?.sql !== undefined && !row.sql.includes(marker)) {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    db.exec(SONG_TABLE_SCHEMA_SQL);
  }
}

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

/**
 * Retire the dead `search_texts.text_norm` column on a legacy database. The
 * column was written but never read (recall lives in `search_tokens`), and
 * `search_texts` is fully rebuilt on every {@link importSongs} and cleared
 * per-song by the delta patcher, so dropping and recreating the table from the
 * current schema loses no durable data. The re-exec of {@link
 * SONG_TABLE_SCHEMA_SQL} recreates only the dropped table (the rest use
 * `IF NOT EXISTS`).
 */
function ensureSearchTextsNoTextNorm(db: SongDatabase): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'search_texts'`)
    .get() as { sql?: string } | undefined;
  if (row?.sql?.includes('text_norm')) {
    db.exec('DROP TABLE IF EXISTS search_texts');
    db.exec(SONG_TABLE_SCHEMA_SQL); // recreates only the dropped table (others are IF NOT EXISTS)
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
