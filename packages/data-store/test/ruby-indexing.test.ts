import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySongDeltaPatch,
  createSongDatabase,
  exportSongs,
  importSongs,
  openSongDatabase,
} from '../src/index.js';
import type { SongDatabase } from '../src/schema.js';

const openDatabases: SongDatabase[] = [];

function openMemoryDb(): SongDatabase {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  createSongDatabase(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

/** ○ / まる — a kanji-ish title whose reading is a pure-katakana ruby. */
const MARU: SongRecord = {
  id: 'joysound-100001',
  source_url: 'https://example.com/joysound/100001',
  title_primary: '○',
  title_ko: null,
  artist_primary: 'テスト',
  artist_ko: null,
  karaoke_numbers: { tj: null, ky: null, joysound: '100001' },
  crawled_at: '2026-02-01T00:00:00.000Z',
  title_ruby: 'マル',
};

const NO_RUBY: SongRecord = {
  id: 'joysound-100002',
  source_url: 'https://example.com/joysound/100002',
  title_primary: 'Plain Title',
  title_ko: null,
  artist_primary: 'Someone',
  artist_ko: null,
  karaoke_numbers: { tj: null, ky: null, joysound: '100002' },
  crawled_at: '2026-02-01T00:00:00.000Z',
};

interface SearchTextRow {
  field: string;
  text_norm: string;
  text_compact: string;
  weight: number;
}

function searchTextRows(db: SongDatabase, songId: string): SearchTextRow[] {
  return db
    .prepare(
      'SELECT field, text_norm, text_compact, weight FROM search_texts WHERE song_id = ? ORDER BY field',
    )
    .all(songId) as unknown as SearchTextRow[];
}

function tokenExists(db: SongDatabase, kind: string, token: string, field: string): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS hit FROM search_tokens WHERE kind = ? AND token = ? AND field = ? LIMIT 1',
    )
    .get(kind, token, field) as { hit: number } | undefined;
  return row !== undefined;
}

describe('title_ruby search indexing (R4)', () => {
  it('indexes the ruby plus its romaji and hangul transliterations as weight-3 search_texts', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU]);

    const rubyRows = searchTextRows(db, MARU.id).filter((row) =>
      row.field.startsWith('title_ruby'),
    );
    expect(rubyRows).toEqual([
      { field: 'title_ruby', text_norm: 'マル', text_compact: 'マル', weight: 3 },
      { field: 'title_ruby_hangul', text_norm: '마루', text_compact: '마루', weight: 3 },
      { field: 'title_ruby_romaji', text_norm: 'maru', text_compact: 'maru', weight: 3 },
    ]);
  });

  it('emits reading tokens the worker query paths look up (romaji term, hangul gram, kana gram)', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU]);

    expect(tokenExists(db, 'term', 'maru', 'title_ruby_romaji')).toBe(true);
    expect(tokenExists(db, 'prefix', 'ma', 'title_ruby_romaji')).toBe(true);
    expect(tokenExists(db, 'gram2', '마루', 'title_ruby_hangul')).toBe(true);
    expect(tokenExists(db, 'gram2', 'マル', 'title_ruby')).toBe(true);
  });

  it('indexes no reading fields for a record without a ruby', () => {
    const db = openMemoryDb();
    importSongs(db, [NO_RUBY]);
    const rubyRows = searchTextRows(db, NO_RUBY.id).filter((row) =>
      row.field.startsWith('title_ruby'),
    );
    expect(rubyRows).toEqual([]);
  });

  it('round-trips title_ruby through the songs table on export', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU, NO_RUBY]);
    const exported = exportSongs(db);
    expect(exported.find((record) => record.id === MARU.id)?.title_ruby).toBe('マル');
    // A record without a ruby must not gain a title_ruby key.
    expect(exported.find((record) => record.id === NO_RUBY.id)).not.toHaveProperty('title_ruby');
  });

  it('keeps a ruby-carrying corpus consistent through the delta patcher base-match check', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU, NO_RUBY]);
    const changed: SongRecord = { ...NO_RUBY, title_ruby: 'プレイン' };
    // checkDbMatchesBase (default) compares exportSongs(db) to baseRecords; this
    // only passes because the ruby is persisted and exported faithfully.
    const manifest = applySongDeltaPatch({
      db,
      baseRecords: [MARU, NO_RUBY],
      candidateRecords: [MARU, changed],
      // The two-song fixture trips the broad-change guards; raise them so the
      // base-match + re-index behaviour under test can run.
      maxTouchedRatio: 1,
      maxTouchedSongs: 10,
    });
    expect(manifest.changedCount).toBe(1);
    expect(tokenExists(db, 'term', 'purein', 'title_ruby_romaji')).toBe(true);
  });
});
