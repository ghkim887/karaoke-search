import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { runDataStoreCli } from '../src/cli.js';
import {
  D1_SCHEMA_SQL,
  buildD1ImportSql,
  createSongDatabase,
  exportD1ImportSqlJson,
  exportSongs,
  exportSongsJson,
  importSongs,
  importSongsJson,
  openSongDatabase,
} from '../src/index.js';

const openDatabases: Array<{ close(): void }> = [];

function openMemoryDb() {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'blog-1',
    source_url: 'https://example.com/blog/1',
    title_primary: 'Yoru ni Kakeru',
    title_ko: 'Night Running',
    artist_primary: 'YOASOBI',
    artist_ko: null,
    artist_aliases: ['Yoasobi Alias', 'Yoasobi Alt'],
    karaoke_numbers: { tj: '68000', ky: null, joysound: '123456' },
    crawled_at: '2026-01-01T00:00:00.000Z',
    title_ko_source: 'manual',
  },
  {
    id: 'tj-2',
    source_url: 'https://example.com/tj/2',
    title_primary: 'Reincarnation Apple',
    title_ko: null,
    artist_primary: 'PinocchioP',
    artist_ko: null,
    karaoke_numbers: { tj: '68222', ky: '44999', joysound: null },
    crawled_at: '2026-01-02T00:00:00.000Z',
    media_context_ko: '(Vocaloid)',
  },
];

const CJK_SEARCH_RECORD: SongRecord = {
  id: 'joysound-613446',
  source_url: 'https://example.com/joysound/613446',
  title_primary: '残酷な天使のテーゼ',
  title_ko: '사랑했나봐',
  artist_primary: "B'z",
  artist_ko: '비즈',
  artist_aliases: ['Mrs. GREEN APPLE'],
  karaoke_numbers: { tj: '068748', ky: null, joysound: '613446' },
  crawled_at: '2026-01-03T00:00:00.000Z',
};

function cloneRecords(records: readonly SongRecord[]): SongRecord[] {
  return structuredClone(records) as SongRecord[];
}

function fixtureRecord(index: number): SongRecord {
  const record = FIXTURE_RECORDS[index];
  if (record === undefined) {
    throw new Error(`Missing fixture record at index ${index}`);
  }
  return record;
}

describe('SQLite song store', () => {
  it('round-trips SongRecord objects without changing order or optional fields', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, FIXTURE_RECORDS);

    const exported = exportSongs(db);
    expect(exported).toEqual(FIXTURE_RECORDS);
    expect(JSON.stringify(exported)).toBe(JSON.stringify(FIXTURE_RECORDS));
  });

  it('preserves an explicit empty artist_aliases array', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    const records = cloneRecords(FIXTURE_RECORDS);
    records[0] = { ...fixtureRecord(0), artist_aliases: [] };

    importSongs(db, records);

    const exported = exportSongs(db);
    expect(exported).toEqual(records);
    expect(JSON.stringify(exported)).toBe(JSON.stringify(records));
  });

  it('is idempotent when importing the same source corpus twice', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, FIXTURE_RECORDS);
    importSongs(db, FIXTURE_RECORDS);

    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('treats importSongs as a complete corpus replacement', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    const secondRecord = fixtureRecord(1);

    importSongs(db, FIXTURE_RECORDS);
    importSongs(db, [secondRecord]);

    expect(exportSongs(db)).toEqual([secondRecord]);
  });

  it('rejects duplicate song ids before changing the database', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, FIXTURE_RECORDS);
    const firstRecord = fixtureRecord(0);
    const duplicate = {
      ...fixtureRecord(1),
      id: firstRecord.id,
      title_primary: 'Duplicate Should Not Win',
    };

    expect(() => importSongs(db, [firstRecord, duplicate])).toThrow(/Duplicate song id: blog-1/);
    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('imports and exports a JSON corpus file through a SQLite database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const inputPath = join(dir, 'songs.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const json = `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`;
    writeFileSync(inputPath, json, 'utf8');

    importSongsJson({ inputPath, dbPath });
    exportSongsJson({ dbPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toBe(json);
  });

  it('does not replace an existing SQLite database when JSON import fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const validPath = join(dir, 'valid.json');
    const invalidPath = join(dir, 'invalid.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const validJson = `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`;
    writeFileSync(validPath, validJson, 'utf8');
    writeFileSync(invalidPath, '{not-valid-json', 'utf8');
    importSongsJson({ inputPath: validPath, dbPath });

    expect(() => importSongsJson({ inputPath: invalidPath, dbPath })).toThrow();
    exportSongsJson({ dbPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toBe(validJson);
  });

  it('exposes D1 schema SQL that creates a store-compatible database', () => {
    const db = openMemoryDb();

    db.exec(D1_SCHEMA_SQL);
    importSongs(db, FIXTURE_RECORDS);

    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('creates derived search index tables and lookup indexes', () => {
    const db = openMemoryDb();

    db.exec(D1_SCHEMA_SQL);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN ('search_texts', 'search_tokens', 'search_token_stats')
        ORDER BY name ASC`,
      )
      .all() as unknown as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'search_texts',
      'search_token_stats',
      'search_tokens',
    ]);

    const searchTextColumns = db
      .prepare('PRAGMA table_info(search_texts)')
      .all() as unknown as Array<{
      name: string;
    }>;
    expect(searchTextColumns.map((column) => column.name)).toEqual([
      'song_id',
      'field',
      'text_norm',
      'text_compact',
      'weight',
      'provider_mask',
    ]);

    const numberColumns = db
      .prepare('PRAGMA table_info(karaoke_numbers)')
      .all() as unknown as Array<{
      name: string;
    }>;
    expect(numberColumns.map((column) => column.name)).toEqual([
      'song_id',
      'provider',
      'number',
      'number_key',
    ]);

    const numberIndexes = db
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE 'idx_karaoke_numbers_%'
        ORDER BY name ASC`,
      )
      .all() as unknown as Array<{ name: string }>;
    expect(numberIndexes.map((row) => row.name)).toEqual([
      'idx_karaoke_numbers_number',
      'idx_karaoke_numbers_number_key',
      'idx_karaoke_numbers_provider_number',
    ]);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE 'idx_search_%'
        ORDER BY name ASC`,
      )
      .all() as unknown as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      'idx_search_texts_compact',
      'idx_search_texts_song',
      'idx_search_tokens_lookup',
      'idx_search_tokens_song',
    ]);
  });

  it('materializes exact text, token, and token-stat search index rows during SQLite import', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [CJK_SEARCH_RECORD]);

    const numberKey = db
      .prepare(
        `SELECT number_key FROM karaoke_numbers
        WHERE song_id = ? AND provider = 'tj'`,
      )
      .get(CJK_SEARCH_RECORD.id) as unknown as { number_key: string };
    expect(numberKey.number_key).toBe('68748');

    const exactTexts = db
      .prepare(
        `SELECT field, text_compact, weight, provider_mask
        FROM search_texts
        WHERE song_id = ?
        ORDER BY field ASC, text_compact ASC`,
      )
      .all(CJK_SEARCH_RECORD.id) as unknown as Array<{
      field: string;
      text_compact: string;
      weight: number;
      provider_mask: number;
    }>;
    expect(exactTexts).toEqual(
      expect.arrayContaining([
        {
          field: 'title_primary',
          text_compact: '残酷な天使のテーゼ',
          weight: 5,
          provider_mask: 5,
        },
        {
          field: 'artist_alias',
          text_compact: 'mrsgreenapple',
          weight: 2,
          provider_mask: 5,
        },
      ]),
    );

    const tokens = db
      .prepare(
        `SELECT kind, token, field
        FROM search_tokens
        WHERE song_id = ?
        ORDER BY kind ASC, token ASC, field ASC`,
      )
      .all(CJK_SEARCH_RECORD.id) as unknown as Array<{
      kind: string;
      token: string;
      field: string;
    }>;
    expect(tokens).toEqual(
      expect.arrayContaining([
        { kind: 'gram2', token: '天使', field: 'title_primary' },
        { kind: 'gram3', token: '天使の', field: 'title_primary' },
        { kind: 'initial', token: 'ㅅㄹㅎㄴㅂ', field: 'title_ko' },
        { kind: 'prefix', token: 'mr', field: 'artist_alias' },
      ]),
    );

    const tokenStats = db
      .prepare(
        `SELECT df, idf_scaled FROM search_token_stats WHERE kind = 'gram2' AND token = '天使'`,
      )
      .get() as unknown as { df: number; idf_scaled: number };
    expect(tokenStats.df).toBe(1);
    expect(tokenStats.idf_scaled).toBeGreaterThan(0);
  });

  it('builds a complete D1 replacement SQL dump that populates derived search indexes', () => {
    const db = openMemoryDb();

    db.exec(buildD1ImportSql([CJK_SEARCH_RECORD]));

    expect(exportSongs(db)).toEqual([CJK_SEARCH_RECORD]);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM search_texts').get() as unknown as {
          count: number;
        }
      ).count,
    ).toBeGreaterThan(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM search_tokens').get() as unknown as {
          count: number;
        }
      ).count,
    ).toBeGreaterThan(0);
    expect(
      (
        db.prepare('SELECT COUNT(*) AS count FROM search_token_stats').get() as unknown as {
          count: number;
        }
      ).count,
    ).toBeGreaterThan(0);
  });

  it('batches generated D1 SQL inserts below Cloudflare statement-size limits', () => {
    const records = Array.from({ length: 150 }, (_, index): SongRecord => {
      const songNumber = 613446 + index;
      return {
        ...CJK_SEARCH_RECORD,
        id: `joysound-${songNumber}`,
        source_url: `https://example.com/joysound/${songNumber}`,
        karaoke_numbers: { tj: `0${68748 + index}`, ky: null, joysound: String(songNumber) },
      };
    });

    const sql = buildD1ImportSql(records);
    const statements = sql
      .trim()
      .split(/;\n/u)
      .map((statement) => `${statement};`);
    const maxStatementBytes = Math.max(
      ...statements.map((statement) => Buffer.byteLength(statement, 'utf8')),
    );

    expect(maxStatementBytes).toBeLessThanOrEqual(100_000);
    expect(sql.match(/^INSERT INTO search_tokens/gmu)?.length ?? 0).toBeGreaterThan(1);
  });

  it('builds a complete D1 replacement SQL dump that preserves escaped text fields', () => {
    const db = openMemoryDb();
    const records = cloneRecords(FIXTURE_RECORDS);
    records[0] = {
      ...fixtureRecord(0),
      source_url: "https://example.com/song?name=Rock'n'Roll",
      title_primary: "Rock 'n' Roll\nSong",
      title_ko: '별빛_%_노래',
      artist_primary: 'Back\\Slash; DROP TABLE songs; --',
      artist_aliases: ["Alias 'One'", 'Line\nTwo'],
    };

    db.exec(buildD1ImportSql(records));

    expect(exportSongs(db)).toEqual(records);
  });

  it('writes a schema-prefixed D1 SQL import file from a JSON corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const inputPath = join(dir, 'songs.json');
    const outputPath = join(dir, 'songs-d1.sql');
    writeFileSync(inputPath, `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`, 'utf8');

    exportD1ImportSqlJson({ inputPath, outputPath });

    const db = openMemoryDb();
    db.exec(readFileSync(outputPath, 'utf8'));
    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('supports exporting a D1 SQL file through the data-store CLI runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const inputPath = join(dir, 'songs.json');
    const outputPath = join(dir, 'songs-d1-cli.sql');
    writeFileSync(inputPath, `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`, 'utf8');

    runDataStoreCli(['export-d1-sql', '--input', inputPath, '--output', outputPath]);

    const db = openMemoryDb();
    db.exec(readFileSync(outputPath, 'utf8'));
    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });
});
