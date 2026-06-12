import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { validateSongRecord } from '@karaoke/schema';
import {
  compactSearchText,
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

type SearchField = (typeof SEARCH_TEXT_FIELDS)[number]['field'];
type SearchTokenKind = 'term' | 'prefix' | 'gram2' | 'gram3' | 'initial';

function sqlite(): SqliteModule {
  return require('node:sqlite') as SqliteModule;
}

const D1_TABLE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)), crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT);
CREATE TABLE IF NOT EXISTS karaoke_numbers (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')), number TEXT, number_key TEXT, PRIMARY KEY (song_id, provider));
CREATE TABLE IF NOT EXISTS artist_aliases (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position));
CREATE TABLE IF NOT EXISTS search_texts (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), text_norm TEXT NOT NULL, text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (song_id, field, text_compact));
CREATE TABLE IF NOT EXISTS search_tokens (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (kind, token, song_id, field));
CREATE TABLE IF NOT EXISTS search_token_stats (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, df INTEGER NOT NULL, idf_scaled INTEGER NOT NULL, PRIMARY KEY (kind, token));`;

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
  db.exec(D1_INDEX_SCHEMA_SQL);
}

export function importSongs(db: SongDatabase, records: readonly SongRecord[]): void {
  validateSongCorpus(records);
  const searchIndex = buildSearchIndexRows(records);
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
    `INSERT INTO search_texts (
      song_id,
      field,
      text_norm,
      text_compact,
      weight,
      provider_mask
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertSearchToken = db.prepare(
    `INSERT INTO search_tokens (
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

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM search_token_stats; DELETE FROM search_tokens; DELETE FROM search_texts');
    db.exec('DELETE FROM temp_import_song_ids');
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
    });

    for (const row of searchIndex.texts) {
      insertSearchText.run(
        row.songId,
        row.field,
        row.textNorm,
        row.textCompact,
        row.weight,
        row.providerMask,
      );
    }
    for (const row of searchIndex.tokens) {
      insertSearchToken.run(
        row.kind,
        row.token,
        row.songId,
        row.field,
        row.weight,
        row.providerMask,
      );
    }
    for (const row of searchIndex.tokenStats) {
      insertSearchTokenStat.run(row.kind, row.token, row.df, row.idfScaled);
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
}

export interface ExportSongsJsonArgs {
  dbPath: string;
  outputPath: string;
}

export function importSongsJson({ inputPath, dbPath }: ImportSongsJsonArgs): void {
  const parsed = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`importSongsJson: expected an array in ${inputPath}`);
  }

  const tempDbPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
  rmSync(tempDbPath, { force: true });
  let readyToReplace = false;
  const db = openSongDatabase(tempDbPath);
  try {
    createSongDatabase(db);
    importSongs(db, parsed as SongRecord[]);
    readyToReplace = true;
  } finally {
    db.close();
    if (!readyToReplace) {
      rmSync(tempDbPath, { force: true });
    }
  }

  replaceFile(tempDbPath, dbPath);
}

export function exportSongsJson({ dbPath, outputPath }: ExportSongsJsonArgs): void {
  const db = openSongDatabase(dbPath);
  try {
    writeFileSync(outputPath, `${JSON.stringify(exportSongs(db), null, 2)}\n`, 'utf8');
  } finally {
    db.close();
  }
}

function buildSearchIndexRows(records: readonly SongRecord[]): SearchIndexRows {
  const texts: SearchTextRow[] = [];
  const tokens: SearchTokenRow[] = [];
  const seenTexts = new Set<string>();
  const seenTokens = new Set<string>();

  for (const record of records) {
    const providerMask = karaokeProviderMask(record.karaoke_numbers);

    for (const input of searchTextInputs(record)) {
      const textCompact = compactSearchText(input.value);
      if (textCompact.length === 0) {
        continue;
      }

      const textNorm = normalizeSearchText(input.value).trim();
      const textKey = `${record.id}\u0000${input.field}\u0000${textCompact}`;
      if (!seenTexts.has(textKey)) {
        seenTexts.add(textKey);
        texts.push({
          songId: record.id,
          field: input.field,
          textNorm,
          textCompact,
          weight: input.weight,
          providerMask,
        });
      }

      addSearchTokens(tokens, seenTokens, {
        songId: record.id,
        field: input.field,
        value: input.value,
        textCompact,
        weight: input.weight,
        providerMask,
      });
    }
  }

  return { texts, tokens, tokenStats: buildSearchTokenStats(tokens, records.length) };
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

function buildSearchTokenStats(
  tokens: readonly SearchTokenRow[],
  totalRecords: number,
): SearchTokenStatRow[] {
  const songsByToken = new Map<string, Set<string>>();
  for (const token of tokens) {
    const key = `${token.kind}\u0000${token.token}`;
    let songIds = songsByToken.get(key);
    if (songIds === undefined) {
      songIds = new Set<string>();
      songsByToken.set(key, songIds);
    }
    songIds.add(token.songId);
  }

  return Array.from(songsByToken, ([key, songIds]) => {
    const separator = key.indexOf('\u0000');
    const kind = key.slice(0, separator) as SearchTokenKind;
    const token = key.slice(separator + 1);
    const df = songIds.size;
    return {
      kind,
      token,
      df,
      idfScaled: Math.max(1, Math.round(Math.log1p(Math.max(totalRecords, 1) / df) * 1000)),
    };
  });
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

interface SearchIndexRows {
  texts: SearchTextRow[];
  tokens: SearchTokenRow[];
  tokenStats: SearchTokenStatRow[];
}

interface SearchTextInput {
  field: SearchField;
  value: string;
  weight: number;
}

interface SearchTokenInput extends SearchTextInput {
  songId: string;
  textCompact: string;
  providerMask: number;
}

interface SearchTextRow {
  songId: string;
  field: SearchField;
  textNorm: string;
  textCompact: string;
  weight: number;
  providerMask: number;
}

interface SearchTokenRow {
  kind: SearchTokenKind;
  token: string;
  songId: string;
  field: SearchField;
  weight: number;
  providerMask: number;
}

interface SearchTokenStatRow {
  kind: SearchTokenKind;
  token: string;
  df: number;
  idfScaled: number;
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
