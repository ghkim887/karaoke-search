import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type SearchDatabase, handleRequest } from '../src/index.js';
import { SqliteSearchDatabase } from '../src/sqlite-adapter.js';

const openDatabases: SongDatabase[] = [];

function makeDb(records: readonly SongRecord[]): SearchDatabase {
  const sqlite = openSongDatabase(':memory:');
  openDatabases.push(sqlite);
  createSongDatabase(sqlite);
  importSongs(sqlite, records);
  return new SqliteSearchDatabase(sqlite);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

async function searchIds(db: SearchDatabase, query: string): Promise<string[]> {
  const url = new URL('https://test/api/search');
  url.searchParams.set('q', query);
  const response = await handleRequest(new Request(url), { db });
  const body = (await response.json()) as { items: SongRecord[] };
  return body.items.map((item) => item.id);
}

// A kanji title whose reading (マル) is only recoverable via title_ruby, plus a
// couple of distractors so a match is meaningful rather than the only row.
const RECORDS: SongRecord[] = [
  {
    id: 'joysound-1',
    source_url: 'https://example.com/1',
    title_primary: '○',
    title_ko: null,
    artist_primary: 'アーティスト',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '1' },
    crawled_at: '2026-01-01T00:00:00.000Z',
    title_ruby: 'マル',
  },
  {
    id: 'joysound-2',
    source_url: 'https://example.com/2',
    title_primary: '夜遊び',
    title_ko: null,
    artist_primary: 'YOASOBI',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '2' },
    crawled_at: '2026-01-02T00:00:00.000Z',
    title_ruby: 'ヨアソビ',
  },
  {
    id: 'joysound-3',
    source_url: 'https://example.com/3',
    title_primary: 'Unrelated Song',
    title_ko: null,
    artist_primary: 'Nobody',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '3' },
    crawled_at: '2026-01-03T00:00:00.000Z',
  },
];

describe('reading search over title_ruby (R4)', () => {
  it('finds a kanji title by its kana reading', async () => {
    const db = makeDb(RECORDS);
    expect(await searchIds(db, 'マル')).toContain('joysound-1');
  });

  it('finds a kanji title by its romaji reading', async () => {
    const db = makeDb(RECORDS);
    expect(await searchIds(db, 'maru')).toContain('joysound-1');
  });

  it('finds a kanji title by its hangul reading', async () => {
    const db = makeDb(RECORDS);
    expect(await searchIds(db, '마루')).toContain('joysound-1');
  });

  it('supports reading prefixes across scripts (yoa / 요아 -> ヨアソビ)', async () => {
    const db = makeDb(RECORDS);
    expect(await searchIds(db, 'yoa')).toContain('joysound-2');
    expect(await searchIds(db, '요아')).toContain('joysound-2');
  });

  it('never exposes title_ruby in the API response (search-only field)', async () => {
    const db = makeDb(RECORDS);
    const url = new URL('https://test/api/search');
    url.searchParams.set('q', 'マル');
    const response = await handleRequest(new Request(url), { db });
    const body = (await response.json()) as { items: Record<string, unknown>[] };
    const hit = body.items.find((item) => item.id === 'joysound-1');
    expect(hit).toBeDefined();
    expect(hit).not.toHaveProperty('title_ruby');
  });
});
