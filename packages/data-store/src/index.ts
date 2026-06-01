import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Category, KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { validateSongRecord } from '@karaoke/schema';

type SqliteModule = typeof import('node:sqlite');
type TitleKoSource = NonNullable<SongRecord['title_ko_source']>;
type TitleKoConfidence = NonNullable<SongRecord['title_ko_confidence']>;
export type SongDatabase = import('node:sqlite').DatabaseSync;

const require = createRequire(import.meta.url);

function sqlite(): SqliteModule {
  return require('node:sqlite') as SqliteModule;
}

export function openSongDatabase(path: string): SongDatabase {
  return new (sqlite().DatabaseSync)(path);
}

export function createSongDatabase(db: SongDatabase): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL,
      source_url TEXT NOT NULL,
      title_primary TEXT NOT NULL,
      title_ko TEXT,
      artist_primary TEXT NOT NULL,
      artist_ko TEXT,
      artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)),
      crawled_at TEXT NOT NULL,
      media_context_ko TEXT,
      title_ko_source TEXT,
      title_ko_confidence TEXT
    );

    CREATE TABLE IF NOT EXISTS karaoke_numbers (
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')),
      number TEXT,
      PRIMARY KEY (song_id, provider)
    );

    CREATE TABLE IF NOT EXISTS song_categories (
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('jpop', 'vocaloid', 'anime')),
      PRIMARY KEY (song_id, position)
    );

    CREATE TABLE IF NOT EXISTS artist_aliases (
      song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (song_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_songs_sort_order ON songs(sort_order, id);
    CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_provider_number
      ON karaoke_numbers(provider, number)
      WHERE number IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_song_categories_category ON song_categories(category);
  `);
  ensureSongsColumn(
    db,
    'artist_aliases_present',
    'ALTER TABLE songs ADD COLUMN artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1))',
  );
}

export function importSongs(db: SongDatabase, records: readonly SongRecord[]): void {
  validateSongCorpus(records);
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
  const deleteCategories = db.prepare('DELETE FROM song_categories WHERE song_id = ?');
  const deleteAliases = db.prepare('DELETE FROM artist_aliases WHERE song_id = ?');
  const insertNumber = db.prepare(
    'INSERT INTO karaoke_numbers (song_id, provider, number) VALUES (?, ?, ?)',
  );
  const insertCategory = db.prepare(
    'INSERT INTO song_categories (song_id, position, category) VALUES (?, ?, ?)',
  );
  const insertAlias = db.prepare(
    'INSERT INTO artist_aliases (song_id, position, alias) VALUES (?, ?, ?)',
  );

  db.exec('BEGIN');
  try {
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
      deleteCategories.run(record.id);
      deleteAliases.run(record.id);

      insertNumber.run(record.id, 'tj', record.karaoke_numbers.tj);
      insertNumber.run(record.id, 'ky', record.karaoke_numbers.ky);
      insertNumber.run(record.id, 'joysound', record.karaoke_numbers.joysound);

      record.categories.forEach((category, categoryIndex) => {
        insertCategory.run(record.id, categoryIndex, category);
      });
      record.artist_aliases?.forEach((alias, aliasIndex) => {
        insertAlias.run(record.id, aliasIndex, alias);
      });
    });
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

  const categoryQuery = db.prepare(
    'SELECT category FROM song_categories WHERE song_id = ? ORDER BY position ASC',
  );
  const numberQuery = db.prepare('SELECT provider, number FROM karaoke_numbers WHERE song_id = ?');
  const aliasQuery = db.prepare(
    'SELECT alias FROM artist_aliases WHERE song_id = ? ORDER BY position ASC',
  );

  return rows.map((row): SongRecord => {
    const categories = (categoryQuery.all(row.id) as unknown as CategoryRow[]).map(
      (categoryRow) => categoryRow.category,
    );
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
      categories,
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

function ensureSongsColumn(db: SongDatabase, columnName: string, alterSql: string): void {
  const columns = db.prepare('PRAGMA table_info(songs)').all() as unknown as TableInfoRow[];
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(alterSql);
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

interface CategoryRow {
  category: Category;
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
