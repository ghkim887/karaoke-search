import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSongDatabase,
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
    categories: ['jpop'],
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
    categories: ['vocaloid'],
    crawled_at: '2026-01-02T00:00:00.000Z',
    media_context_ko: '(Vocaloid)',
  },
];

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
});
