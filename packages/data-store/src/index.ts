import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { validateSongRecord } from '@karaoke/schema';
import {
  compactSearchText,
  deriveKanaRomaji,
  makeCharacterNgrams,
  makeHangulInitials,
  normalizeKaraokeNumber,
  normalizeSearchText,
  tokenizeSearchWords,
} from '@karaoke/search';

type SqliteModule = typeof import('node:sqlite');
type TitleKoSource = NonNullable<SongRecord['title_ko_source']>;
type TitleKoConfidence = NonNullable<SongRecord['title_ko_confidence']>;
export type SongDatabase = import('node:sqlite').DatabaseSync;

const require = createRequire(import.meta.url);
const KARAOKE_PROVIDERS = ['tj', 'ky', 'joysound'] as const;
const PROVIDER_MASKS = { tj: 1, ky: 2, joysound: 4 } as const;
const SEARCH_TEXT_FIELDS = [
  { field: 'title_primary', weight: 5 },
  { field: 'title_ko', weight: 5 },
  { field: 'artist_primary', weight: 3 },
  { field: 'artist_ko', weight: 3 },
  { field: 'artist_alias', weight: 2 },
] as const;
const MAX_PREFIX_LENGTH = 12;

/**
 * SEARCH-ONLY hint weight for tokens derived from `search_hints` rows. Kept
 * strictly below every canonical field weight (artist_alias is the lowest at 2)
 * so a hint match can improve recall but never outranks a canonical match, and
 * hints never receive the `search_texts` exact-compact boost at all. Search
 * hints must never feed crawler/classifier/admit/drop decisions.
 */
const HINT_TOKEN_WEIGHT = 1;
const HINT_FIELDS = ['title', 'artist'] as const;
const HINT_TOKEN_FIELD_BY_HINT_FIELD = {
  title: 'title_hint',
  artist: 'artist_hint',
} as const;
const DEFAULT_HINT_CONFIDENCE: HintConfidence = 'medium';
/** Provenance tag for romaji hints derived from a kana hint at build time. */
const DERIVED_KANA_ROMAJI_SOURCE = 'derived_kana_romaji';

type SearchField = (typeof SEARCH_TEXT_FIELDS)[number]['field'];
type HintField = (typeof HINT_FIELDS)[number];
type HintTokenField = (typeof HINT_TOKEN_FIELD_BY_HINT_FIELD)[HintField];
type SearchTokenField = SearchField | HintTokenField;
type HintConfidence = NonNullable<TitleKoConfidence>;
type SearchTokenKind = 'term' | 'prefix' | 'gram1' | 'gram2' | 'gram3' | 'initial';

function sqlite(): SqliteModule {
  return require('node:sqlite') as SqliteModule;
}

const D1_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)), crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT);
CREATE TABLE IF NOT EXISTS karaoke_numbers (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')), number TEXT, number_key TEXT, PRIMARY KEY (song_id, provider));
CREATE TABLE IF NOT EXISTS artist_aliases (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position));
CREATE TABLE IF NOT EXISTS search_texts (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), text_norm TEXT NOT NULL, text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (song_id, field, text_compact));
CREATE TABLE IF NOT EXISTS search_tokens (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram1', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias', 'title_hint', 'artist_hint')), weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (kind, token, song_id, field));
CREATE TABLE IF NOT EXISTS search_token_stats (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram1', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, df INTEGER NOT NULL, idf_scaled INTEGER NOT NULL, PRIMARY KEY (kind, token));
CREATE TABLE IF NOT EXISTS search_hints (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title', 'artist')), source TEXT NOT NULL, text_norm TEXT NOT NULL, text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')), PRIMARY KEY (song_id, field, source, text_compact));`;

const D1_INDEX_SCHEMA_SQL = `CREATE INDEX IF NOT EXISTS idx_songs_sort_order ON songs(sort_order, id);
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
 * The `D1_` prefix is historical — the schema started life on Cloudflare D1
 * (removed 2026-06-13) and the name is kept to avoid churn.
 */
export const D1_SCHEMA_SQL = `${D1_TABLE_SCHEMA_SQL}
${D1_INDEX_SCHEMA_SQL}`;

export function openSongDatabase(path: string): SongDatabase {
  return new (sqlite().DatabaseSync)(path);
}

export function createSongDatabase(db: SongDatabase): void {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(D1_TABLE_SCHEMA_SQL);
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
  db.exec(D1_INDEX_SCHEMA_SQL);
}

/**
 * Upgrade a legacy database whose `search_tokens.field` CHECK predates the
 * search-hint fields. SQLite cannot widen a CHECK in place, but `search_tokens`
 * is fully derived and rebuilt on every {@link importSongs}, so dropping and
 * recreating it from the current schema loses nothing. The re-exec of
 * {@link D1_TABLE_SCHEMA_SQL} recreates only the dropped table (the rest use
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
    db.exec(D1_TABLE_SCHEMA_SQL);
  }
}

/**
 * A single SEARCH-ONLY hint: an alternate string (e.g. a JOYSOUND `songNameRuby`
 * reading or a derived romanization) that should improve recall for a song
 * WITHOUT being part of the canonical {@link SongRecord}. Hints feed only the
 * `search_hints` / `search_tokens` tables and never crawler/admit/drop logic.
 */
export interface SearchHintInput {
  /** Canonical song id the hint applies to. Unknown ids are ignored. */
  songId: string;
  /** Whether the hint is an alternate title or artist string. */
  field: 'title' | 'artist';
  /** The alternate text (kana reading, romanization, etc.). */
  text: string;
  /** Provenance tag, e.g. `joysound_songNameRuby`, `derived_kana_romaji`. */
  source: string;
  /** Defaults to `medium` when omitted. */
  confidence?: 'high' | 'medium' | 'low';
}

export interface ImportSongsOptions {
  /** SEARCH-ONLY recall hints to index alongside the canonical corpus. */
  searchHints?: readonly SearchHintInput[];
}

export function importSongs(
  db: SongDatabase,
  records: readonly SongRecord[],
  options: ImportSongsOptions = {},
): void {
  validateSongCorpus(records);
  const resolvedHints = resolveSearchHints(options.searchHints ?? [], records);
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS temp_import_song_ids (id TEXT PRIMARY KEY) WITHOUT ROWID',
  );

  const upsertSong = db.prepare(`
    INSERT INTO songs (
      id,
      sort_order,
      source_url,
      title_primary,
      title_ko,
      artist_primary,
      artist_ko,
      artist_aliases_present,
      crawled_at,
      media_context_ko,
      title_ko_source,
      title_ko_confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sort_order = excluded.sort_order,
      source_url = excluded.source_url,
      title_primary = excluded.title_primary,
      title_ko = excluded.title_ko,
      artist_primary = excluded.artist_primary,
      artist_ko = excluded.artist_ko,
      artist_aliases_present = excluded.artist_aliases_present,
      crawled_at = excluded.crawled_at,
      media_context_ko = excluded.media_context_ko,
      title_ko_source = excluded.title_ko_source,
      title_ko_confidence = excluded.title_ko_confidence
  `);
  const insertImportId = db.prepare('INSERT INTO temp_import_song_ids (id) VALUES (?)');
  const deleteNumbers = db.prepare('DELETE FROM karaoke_numbers WHERE song_id = ?');
  const deleteAliases = db.prepare('DELETE FROM artist_aliases WHERE song_id = ?');
  const insertNumber = db.prepare(
    'INSERT INTO karaoke_numbers (song_id, provider, number, number_key) VALUES (?, ?, ?, ?)',
  );
  const insertAlias = db.prepare(
    'INSERT INTO artist_aliases (song_id, position, alias) VALUES (?, ?, ?)',
  );
  const insertSearchText = db.prepare(
    `INSERT OR IGNORE INTO search_texts (
      song_id,
      field,
      text_norm,
      text_compact,
      weight,
      provider_mask
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSearchToken = db.prepare(
    `INSERT OR IGNORE INTO search_tokens (
      kind,
      token,
      song_id,
      field,
      weight,
      provider_mask
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSearchTokenStat = db.prepare(
    'INSERT INTO search_token_stats (kind, token, df, idf_scaled) VALUES (?, ?, ?, ?)',
  );
  const insertSearchHint = db.prepare(
    `INSERT OR IGNORE INTO search_hints (
      song_id,
      field,
      source,
      text_norm,
      text_compact,
      weight,
      provider_mask,
      confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    db.exec(
      'DELETE FROM search_token_stats; DELETE FROM search_tokens; DELETE FROM search_texts; DELETE FROM search_hints',
    );
    db.exec('DELETE FROM temp_import_song_ids');
    const insertTokenRowsForInput = (input: SearchTokenInput): void => {
      const rows: SearchTokenRow[] = [];
      addSearchTokens(rows, new Set<string>(), input);
      for (const row of rows) {
        insertSearchToken.run(
          row.kind,
          row.token,
          row.songId,
          row.field,
          row.weight,
          row.providerMask,
        );
      }
    };

    records.forEach((record, index) => {
      insertImportId.run(record.id);
      upsertSong.run(
        record.id,
        index,
        record.source_url,
        record.title_primary,
        record.title_ko,
        record.artist_primary,
        record.artist_ko,
        record.artist_aliases === undefined ? 0 : 1,
        record.crawled_at,
        record.media_context_ko ?? null,
        record.title_ko_source ?? null,
        record.title_ko_confidence ?? null,
      );

      deleteNumbers.run(record.id);
      deleteAliases.run(record.id);

      insertNumber.run(
        record.id,
        'tj',
        record.karaoke_numbers.tj,
        karaokeNumberKey(record.karaoke_numbers.tj),
      );
      insertNumber.run(
        record.id,
        'ky',
        record.karaoke_numbers.ky,
        karaokeNumberKey(record.karaoke_numbers.ky),
      );
      insertNumber.run(
        record.id,
        'joysound',
        record.karaoke_numbers.joysound,
        karaokeNumberKey(record.karaoke_numbers.joysound),
      );

      record.artist_aliases?.forEach((alias, aliasIndex) => {
        insertAlias.run(record.id, aliasIndex, alias);
      });

      const providerMask = karaokeProviderMask(record.karaoke_numbers);
      for (const input of searchTextInputs(record)) {
        const textCompact = compactSearchText(input.value);
        if (textCompact.length === 0) {
          continue;
        }
        insertSearchText.run(
          record.id,
          input.field,
          normalizeSearchText(input.value).trim(),
          textCompact,
          input.weight,
          providerMask,
        );
        insertTokenRowsForInput({
          songId: record.id,
          field: input.field,
          value: input.value,
          textCompact,
          weight: input.weight,
          providerMask,
        });
      }
    });

    for (const hint of resolvedHints) {
      insertSearchHint.run(
        hint.songId,
        hint.field,
        hint.source,
        hint.textNorm,
        hint.textCompact,
        hint.weight,
        hint.providerMask,
        hint.confidence,
      );
      insertTokenRowsForInput({
        songId: hint.songId,
        field: HINT_TOKEN_FIELD_BY_HINT_FIELD[hint.field],
        value: hint.textNorm,
        textCompact: hint.textCompact,
        weight: hint.weight,
        providerMask: hint.providerMask,
      });
    }

    const tokenStatRows = db
      .prepare(
        `SELECT kind, token, COUNT(DISTINCT song_id) AS df
         FROM search_tokens
         GROUP BY kind, token`,
      )
      .all() as unknown as SearchTokenStatSourceRow[];
    for (const row of tokenStatRows) {
      const df = Number(row.df);
      insertSearchTokenStat.run(
        row.kind,
        row.token,
        df,
        Math.max(1, Math.round(Math.log1p(Math.max(records.length, 1) / df) * 1000)),
      );
    }

    db.exec('DELETE FROM songs WHERE id NOT IN (SELECT id FROM temp_import_song_ids)');
    db.exec('DELETE FROM temp_import_song_ids');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function exportSongs(db: SongDatabase): SongRecord[] {
  const rows = db
    .prepare(
      `SELECT
        id,
        source_url,
        title_primary,
        title_ko,
        artist_primary,
        artist_ko,
        artist_aliases_present,
        crawled_at,
        media_context_ko,
        title_ko_source,
        title_ko_confidence
      FROM songs
      ORDER BY sort_order ASC, id ASC`,
    )
    .all() as unknown as StoredSongRow[];

  const numberQuery = db.prepare('SELECT provider, number FROM karaoke_numbers WHERE song_id = ?');
  const aliasQuery = db.prepare(
    'SELECT alias FROM artist_aliases WHERE song_id = ? ORDER BY position ASC',
  );

  return rows.map((row): SongRecord => {
    const karaokeNumbers: KaraokeNumbers = { tj: null, ky: null, joysound: null };
    for (const numberRow of numberQuery.all(row.id) as unknown as KaraokeNumberRow[]) {
      karaokeNumbers[numberRow.provider] = numberRow.number;
    }
    const aliases = (aliasQuery.all(row.id) as unknown as AliasRow[]).map(
      (aliasRow) => aliasRow.alias,
    );

    const record: SongRecord = {
      id: row.id,
      source_url: row.source_url,
      title_primary: row.title_primary,
      title_ko: row.title_ko,
      artist_primary: row.artist_primary,
      artist_ko: row.artist_ko,
      ...(row.artist_aliases_present === 1 || aliases.length > 0
        ? { artist_aliases: aliases }
        : {}),
      karaoke_numbers: karaokeNumbers,
      crawled_at: row.crawled_at,
      ...(row.media_context_ko !== null ? { media_context_ko: row.media_context_ko } : {}),
      ...(row.title_ko_source !== null ? { title_ko_source: row.title_ko_source } : {}),
      ...(row.title_ko_confidence !== null ? { title_ko_confidence: row.title_ko_confidence } : {}),
    };

    validateSongRecord(record);
    return record;
  });
}

export interface ImportSongsJsonArgs {
  inputPath: string;
  dbPath: string;
  /**
   * Optional SEARCH-ONLY hint sidecar files (generic JSON/JSONL or JOYSOUND
   * detail decision-log rows). Parsed with {@link parseSearchHintFile}; hints
   * for song ids absent from `inputPath` are ignored.
   */
  searchHintPaths?: readonly string[];
}

export interface ExportSongsJsonArgs {
  dbPath: string;
  outputPath: string;
}

/** Read and shape-check a `songs.json` corpus array. */
export function readSongRecordsJson(inputPath: string): SongRecord[] {
  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`readSongRecordsJson: expected an array in ${inputPath}`);
  }
  return parsed as SongRecord[];
}

export function importSongsJson({ inputPath, dbPath, searchHintPaths }: ImportSongsJsonArgs): void {
  const records = readSongRecordsJson(inputPath);
  const fileHints = (searchHintPaths ?? []).flatMap((path) => parseSearchHintFile(path));
  importSongRecordsToDatabaseFile(records, dbPath, { searchHints: fileHints });
}

/**
 * Build a fresh SQLite database in a temp file and atomically replace `dbPath`
 * with it, so a failed import never corrupts an existing database. Shared by
 * the sync {@link importSongsJson} and any async build wrapper.
 */
function importSongRecordsToDatabaseFile(
  records: readonly SongRecord[],
  dbPath: string,
  options: ImportSongsOptions,
): void {
  const tempDbPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempDbPath, { force: true });
  let readyToReplace = false;
  const db = openSongDatabase(tempDbPath);
  try {
    createSongDatabase(db);
    importSongs(db, records, options);
    readyToReplace = true;
  } finally {
    db.close();
    if (!readyToReplace) {
      rmSync(tempDbPath, { force: true });
    }
  }

  replaceFile(tempDbPath, dbPath);
}

/**
 * Parse a SEARCH-ONLY hint sidecar file into normalized {@link SearchHintInput}
 * rows. Accepts either a JSON array, a single JSON object, or JSONL (one JSON
 * value per line). Each row may be:
 *
 *   - a generic flat hint — `{ song_id|songId, field, text, source, confidence? }`,
 *   - a grouped hint — `{ song_id|songId, hints: [{ field, text, source, ... }] }`,
 *   - a JOYSOUND detail/decision-log row carrying `detail.songNameRuby` (mapped
 *     to a `title` hint for `joysound-${detail.naviGroupId || naviGroupId}`).
 *
 * Rows that are malformed (missing song id, unknown `field`, empty `text` or
 * `source`, non-`admit` decision logs) are skipped — a sidecar is advisory and
 * must never fail a build. Song-id existence is checked later, at import.
 */
export function parseSearchHintFile(path: string): SearchHintInput[] {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) {
    return [];
  }
  const hints: SearchHintInput[] = [];
  for (const row of parseHintRows(raw)) {
    collectHintsFromRow(row, hints);
  }
  return hints;
}

function parseHintRows(raw: string): unknown[] {
  // Whole-file JSON first (a JSON array, or a single pretty-printed object).
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to JSONL: one JSON value per non-empty line. Malformed lines are
    // skipped rather than aborting the whole file.
    const rows: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        rows.push(JSON.parse(trimmed) as unknown);
      } catch {
        // Skip unparseable line.
      }
    }
    return rows;
  }
}

function collectHintsFromRow(row: unknown, out: SearchHintInput[]): void {
  if (!isPlainObject(row)) {
    return;
  }

  // Grouped form: { songId, hints: [...] }.
  if (Array.isArray(row.hints)) {
    const songId = readHintSongId(row);
    if (songId === null) {
      return;
    }
    for (const hint of row.hints) {
      pushFlatHint(out, songId, hint);
    }
    return;
  }

  // JOYSOUND detail / decision-log form.
  if (isPlainObject(row.detail) || ('naviGroupId' in row && 'selSongNo' in row)) {
    collectJoysoundDetailHint(row, out);
    return;
  }

  // Generic flat form.
  const songId = readHintSongId(row);
  if (songId === null) {
    return;
  }
  pushFlatHint(out, songId, row);
}

function pushFlatHint(out: SearchHintInput[], songId: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    return;
  }
  const field = normalizeHintFieldName(raw.field);
  if (field === null) {
    return;
  }
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (text.length === 0) {
    return;
  }
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (source.length === 0) {
    return;
  }
  const hint: SearchHintInput = { songId, field, text, source };
  if (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low') {
    hint.confidence = raw.confidence;
  }
  out.push(hint);
}

/**
 * Map a JOYSOUND detail/decision-log row to a title ruby hint. Only `admit`
 * rows (or rows with no explicit `decision`) with a non-empty `songNameRuby`
 * are emitted; the canonical song id is `joysound-${detail.naviGroupId ||
 * naviGroupId}`, matching the JOYSOUND normalizer.
 */
function collectJoysoundDetailHint(row: Record<string, unknown>, out: SearchHintInput[]): void {
  if ('decision' in row && row.decision !== 'admit') {
    return;
  }
  const detail = isPlainObject(row.detail) ? row.detail : {};
  const naviGroupId =
    readTrimmedString(detail.naviGroupId) ?? readTrimmedString(row.naviGroupId) ?? '';
  if (naviGroupId.length === 0) {
    return;
  }
  const ruby = readTrimmedString(detail.songNameRuby) ?? '';
  if (ruby.length === 0) {
    return;
  }
  out.push({
    songId: `joysound-${naviGroupId}`,
    field: 'title',
    text: ruby,
    source: 'joysound_songNameRuby',
    confidence: 'high',
  });
}

function readHintSongId(row: Record<string, unknown>): string | null {
  return readTrimmedString(row.song_id) ?? readTrimmedString(row.songId);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeHintFieldName(value: unknown): HintField | null {
  return value === 'title' || value === 'artist' ? value : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function exportSongsJson({ dbPath, outputPath }: ExportSongsJsonArgs): void {
  const db = openSongDatabase(dbPath);
  try {
    writeFileSync(outputPath, `${JSON.stringify(exportSongs(db), null, 2)}\n`, 'utf8');
  } finally {
    db.close();
  }
}

/**
 * Normalize raw {@link SearchHintInput} rows into the rows materialized into
 * `search_hints` (and, during import, the token index).
 *
 * Hints for unknown song ids, unknown fields, or values that compact to nothing
 * are dropped silently — a hint sidecar is advisory recall data, never a hard
 * input, so a malformed row must never fail an import. Rows are deduplicated by
 * `(songId, field, source, text_compact)` (the `search_hints` primary key).
 */
function resolveSearchHints(
  inputs: readonly SearchHintInput[],
  records: readonly SongRecord[],
): ResolvedSearchHint[] {
  const providerMaskById = new Map<string, number>();
  for (const record of records) {
    providerMaskById.set(record.id, karaokeProviderMask(record.karaoke_numbers));
  }

  const resolved: ResolvedSearchHint[] = [];
  const seen = new Set<string>();
  // Every text_compact already indexed per song+field (across all sources), so
  // a derived romaji never duplicates an existing reading.
  const compactsByGroup = new Map<string, Set<string>>();
  const groupCompacts = (songId: string, field: HintField): Set<string> => {
    const groupKey = `${songId} ${field}`;
    let set = compactsByGroup.get(groupKey);
    if (set === undefined) {
      set = new Set<string>();
      compactsByGroup.set(groupKey, set);
    }
    return set;
  };
  const add = (
    songId: string,
    field: HintField,
    source: string,
    text: string,
    confidence: HintConfidence,
  ): void => {
    const providerMask = providerMaskById.get(songId);
    if (providerMask === undefined) {
      return;
    }
    const textCompact = compactSearchText(text);
    if (textCompact.length === 0) {
      return;
    }
    const key = `${songId}\u0000${field}\u0000${source}\u0000${textCompact}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    groupCompacts(songId, field).add(textCompact);
    resolved.push({
      songId,
      field,
      source,
      textNorm: normalizeSearchText(text).trim(),
      textCompact,
      weight: HINT_TOKEN_WEIGHT,
      providerMask,
      confidence,
    });
  };

  for (const input of inputs) {
    if (!isHintField(input.field)) {
      continue;
    }
    if (typeof input.text !== 'string' || typeof input.source !== 'string') {
      continue;
    }
    const confidence = isHintConfidence(input.confidence)
      ? input.confidence
      : DEFAULT_HINT_CONFIDENCE;
    add(input.songId, input.field, input.source, input.text, confidence);
  }

  // P3: derive a romaji recall variant from each directly-supplied kana hint
  // (snapshot first so we never derive from a derived row), inheriting the
  // parent confidence and skipping normalized-equivalent readings.
  for (const hint of [...resolved]) {
    if (hint.source === DERIVED_KANA_ROMAJI_SOURCE) {
      continue;
    }
    const romaji = deriveKanaRomaji(hint.textNorm);
    if (romaji === null) {
      continue;
    }
    if (groupCompacts(hint.songId, hint.field).has(compactSearchText(romaji))) {
      continue;
    }
    add(hint.songId, hint.field, DERIVED_KANA_ROMAJI_SOURCE, romaji, hint.confidence);
  }

  return resolved;
}

function isHintField(value: unknown): value is HintField {
  return typeof value === 'string' && (HINT_FIELDS as readonly string[]).includes(value);
}

function isHintConfidence(value: unknown): value is HintConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

function searchTextInputs(record: SongRecord): SearchTextInput[] {
  const inputs: SearchTextInput[] = [
    {
      field: 'title_primary',
      value: record.title_primary,
      weight: searchFieldWeight('title_primary'),
    },
    {
      field: 'artist_primary',
      value: record.artist_primary,
      weight: searchFieldWeight('artist_primary'),
    },
  ];

  if (record.title_ko !== null) {
    inputs.push({
      field: 'title_ko',
      value: record.title_ko,
      weight: searchFieldWeight('title_ko'),
    });
  }
  if (record.artist_ko !== null) {
    inputs.push({
      field: 'artist_ko',
      value: record.artist_ko,
      weight: searchFieldWeight('artist_ko'),
    });
  }
  for (const alias of record.artist_aliases ?? []) {
    inputs.push({ field: 'artist_alias', value: alias, weight: searchFieldWeight('artist_alias') });
  }

  return inputs;
}

function addSearchTokens(rows: SearchTokenRow[], seen: Set<string>, input: SearchTokenInput): void {
  for (const word of tokenizeSearchWords(input.value)) {
    if (Array.from(word).length >= 2) {
      addSearchToken(rows, seen, input, 'term', word);
    }
    addPrefixTokens(rows, seen, input, word, 'prefix');
  }
  addPrefixTokens(rows, seen, input, input.textCompact, 'prefix');

  for (const gram of makeNonAsciiCharacterUnigrams(input.textCompact)) {
    addSearchToken(rows, seen, input, 'gram1', gram);
  }
  for (const gram of makeCharacterNgrams(input.textCompact, 2)) {
    addSearchToken(rows, seen, input, 'gram2', gram);
  }
  for (const gram of makeCharacterNgrams(input.textCompact, 3)) {
    addSearchToken(rows, seen, input, 'gram3', gram);
  }

  const initials = makeHangulInitials(input.value);
  addPrefixTokens(rows, seen, input, initials, 'initial');
}

function addPrefixTokens(
  rows: SearchTokenRow[],
  seen: Set<string>,
  input: SearchTokenInput,
  value: string,
  kind: SearchTokenKind,
): void {
  const characters = Array.from(value);
  for (let length = 2; length <= Math.min(MAX_PREFIX_LENGTH, characters.length); length += 1) {
    addSearchToken(rows, seen, input, kind, characters.slice(0, length).join(''));
  }
}

function addSearchToken(
  rows: SearchTokenRow[],
  seen: Set<string>,
  input: SearchTokenInput,
  kind: SearchTokenKind,
  token: string,
): void {
  if (token.length === 0) {
    return;
  }

  const key = `${kind}\u0000${token}\u0000${input.songId}\u0000${input.field}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  rows.push({
    kind,
    token,
    songId: input.songId,
    field: input.field,
    weight: input.weight,
    providerMask: input.providerMask,
  });
}

function makeNonAsciiCharacterUnigrams(value: string): string[] {
  const grams: string[] = [];
  const seen = new Set<string>();
  for (const character of Array.from(value)) {
    if (!hasNonAsciiCharacter(character) || seen.has(character)) {
      continue;
    }
    seen.add(character);
    grams.push(character);
  }
  return grams;
}

function hasNonAsciiCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

function karaokeProviderMask(numbers: KaraokeNumbers): number {
  let mask = 0;
  for (const provider of KARAOKE_PROVIDERS) {
    if (numbers[provider] !== null) {
      mask |= PROVIDER_MASKS[provider];
    }
  }
  return mask;
}

function searchFieldWeight(field: SearchField): number {
  const config = SEARCH_TEXT_FIELDS.find((entry) => entry.field === field);
  if (config === undefined) {
    throw new Error(`Unknown search field: ${field}`);
  }
  return config.weight;
}

function validateSongCorpus(records: readonly SongRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    validateSongRecord(record);
    if (seen.has(record.id)) {
      throw new Error(`Duplicate song id: ${record.id}`);
    }
    seen.add(record.id);
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

function karaokeNumberKey(number: string | null): string | null {
  if (number === null) {
    return null;
  }
  const normalized = normalizeKaraokeNumber(number);
  if (normalized.length === 0) {
    return null;
  }
  return normalized.replace(/^0+/u, '') || '0';
}

function replaceFile(sourcePath: string, targetPath: string): void {
  const backupPath = `${targetPath}.${process.pid}.${Date.now()}.bak`;
  let backupCreated = false;
  try {
    rmSync(backupPath, { force: true });
    if (existsSync(targetPath)) {
      renameSync(targetPath, backupPath);
      backupCreated = true;
    }
    renameSync(sourcePath, targetPath);
    if (backupCreated) {
      rmSync(backupPath, { force: true });
      backupCreated = false;
    }
  } catch (error) {
    rmSync(sourcePath, { force: true });
    if (backupCreated && !existsSync(targetPath) && existsSync(backupPath)) {
      renameSync(backupPath, targetPath);
      backupCreated = false;
    }
    throw error;
  } finally {
    if (backupCreated && existsSync(targetPath) && existsSync(backupPath)) {
      rmSync(backupPath, { force: true });
    }
  }
}

interface SearchTextInput {
  field: SearchField;
  value: string;
  weight: number;
}

interface SearchTokenInput {
  songId: string;
  field: SearchTokenField;
  value: string;
  textCompact: string;
  weight: number;
  providerMask: number;
}

interface SearchTokenRow {
  kind: SearchTokenKind;
  token: string;
  songId: string;
  field: SearchTokenField;
  weight: number;
  providerMask: number;
}

/** A normalized, corpus-validated hint ready to be written to `search_hints`. */
interface ResolvedSearchHint {
  songId: string;
  field: HintField;
  source: string;
  textNorm: string;
  textCompact: string;
  weight: number;
  providerMask: number;
  confidence: HintConfidence;
}

interface SearchTokenStatSourceRow {
  kind: SearchTokenKind;
  token: string;
  df: number;
}

interface StoredSongRow {
  id: string;
  source_url: string;
  title_primary: string;
  title_ko: string | null;
  artist_primary: string;
  artist_ko: string | null;
  artist_aliases_present: number;
  crawled_at: string;
  media_context_ko: string | null;
  title_ko_source: TitleKoSource | null;
  title_ko_confidence: TitleKoConfidence | null;
}

interface KaraokeNumberRow {
  provider: keyof KaraokeNumbers;
  number: string | null;
}

interface AliasRow {
  alias: string;
}

interface TableInfoRow {
  name: string;
}
