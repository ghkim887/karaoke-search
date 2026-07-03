import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { validateSongRecord } from '@karaoke/schema';
import { parseSearchHintFile } from './hints.js';
import type { SearchHintInput } from './hints.js';
import { createSongDatabase, openSongDatabase } from './schema.js';
import type { SongDatabase } from './schema.js';
import {
  groupResolvedHints,
  recalculateAllTokenStats,
  resolveSearchHints,
} from './search-index.js';
import { prepareSongWriteStatements, writeSongRecordRows } from './song-writer.js';

type TitleKoSource = NonNullable<SongRecord['title_ko_source']>;
type TitleKoConfidence = NonNullable<SongRecord['title_ko_confidence']>;

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
  const hintsBySongId = groupResolvedHints(resolveSearchHints(options.searchHints ?? [], records));
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS temp_import_song_ids (id TEXT PRIMARY KEY) WITHOUT ROWID',
  );

  const statements = prepareSongWriteStatements(db);
  const insertImportId = db.prepare('INSERT INTO temp_import_song_ids (id) VALUES (?)');

  db.exec('BEGIN');
  try {
    db.exec(
      'DELETE FROM search_token_stats; DELETE FROM search_tokens; DELETE FROM search_texts; DELETE FROM search_hints',
    );
    db.exec('DELETE FROM temp_import_song_ids');

    records.forEach((record, index) => {
      insertImportId.run(record.id);
      // Child rows are keyed by song, not globally cleared like search_*; drop
      // this song's numbers/aliases before the shared writer re-inserts them.
      statements.deleteNumbers.run(record.id);
      statements.deleteAliases.run(record.id);
      writeSongRecordRows(statements, record, index, hintsBySongId.get(record.id) ?? []);
    });

    recalculateAllTokenStats(db, records.length);

    db.exec('DELETE FROM songs WHERE id NOT IN (SELECT id FROM temp_import_song_ids)');
    db.exec('DELETE FROM temp_import_song_ids');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The `songs` columns that hydrate a {@link SongRecord}, in projection order.
 * Single source of truth for every SELECT that materializes a
 * {@link StoredSongRow} (data-store exports and the worker's query paths).
 */
export const SONG_COLUMNS = [
  'id',
  'source_url',
  'title_primary',
  'title_ko',
  'artist_primary',
  'artist_ko',
  'artist_aliases_present',
  'crawled_at',
  'media_context_ko',
  'title_ko_source',
  'title_ko_confidence',
] as const;

/**
 * Builds the `SELECT` projection for {@link SONG_COLUMNS}. Pass a table alias
 * (e.g. `'s'`) to prefix each column for multi-table joins; omit it for a
 * single-table query. Both packages call this so their projections can never
 * drift out of sync.
 */
export function songColumnsProjection(alias?: string): string {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return SONG_COLUMNS.map((column) => `${prefix}${column}`).join(', ');
}

export function exportSongs(db: SongDatabase): SongRecord[] {
  const rows = db
    .prepare(
      `SELECT ${songColumnsProjection()}
      FROM songs
      ORDER BY sort_order ASC, id ASC`,
    )
    .all() as unknown as StoredSongRow[];

  const numberQuery = db.prepare(
    'SELECT song_id, provider, number FROM karaoke_numbers WHERE song_id = ?',
  );
  const aliasQuery = db.prepare(
    'SELECT song_id, alias FROM artist_aliases WHERE song_id = ? ORDER BY position ASC',
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

export function exportSongsJson({ dbPath, outputPath }: ExportSongsJsonArgs): void {
  const db = openSongDatabase(dbPath);
  try {
    writeFileSync(outputPath, `${JSON.stringify(exportSongs(db), null, 2)}\n`, 'utf8');
  } finally {
    db.close();
  }
}

export function validateSongCorpus(records: readonly SongRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    validateSongRecord(record);
    if (seen.has(record.id)) {
      throw new Error(`Duplicate song id: ${record.id}`);
    }
    seen.add(record.id);
  }
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

/**
 * A `songs` row projected via {@link SONG_COLUMNS}. Owned here and consumed by
 * the worker so both packages read the same shape from the same column set.
 */
export interface StoredSongRow {
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

/**
 * A `karaoke_numbers` row. `song_id` is a NOT NULL column present in the
 * worker's batch lookups; single-song exports here omit it from the projection
 * and simply never read it.
 */
export interface KaraokeNumberRow {
  song_id: string;
  provider: keyof KaraokeNumbers;
  number: string | null;
}

/**
 * An `artist_aliases` row. As with {@link KaraokeNumberRow}, `song_id` is the
 * real column that the worker's batch lookups select and read.
 */
export interface AliasRow {
  song_id: string;
  alias: string;
}
