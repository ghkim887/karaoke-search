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

function tokenKinds(db: SongDatabase, field: string): string[] {
  return (
    db
      .prepare('SELECT DISTINCT kind FROM search_tokens WHERE field = ? ORDER BY kind')
      .all(field) as unknown as Array<{ kind: string }>
  ).map((row) => row.kind);
}

function tokenWeight(db: SongDatabase, field: string): number | undefined {
  const row = db.prepare('SELECT DISTINCT weight FROM search_tokens WHERE field = ?').get(field) as
    | { weight: number }
    | undefined;
  return row?.weight;
}

describe('title_ruby search indexing (R4)', () => {
  it('indexes reading fields as TOKEN-ONLY (weight 3) — never in the search_texts exact tier', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU]);

    // No reading field enters search_texts (the worker exact-text tier), so a
    // reading match can never outrank a real exact title/artist match.
    const rubyTextRows = searchTextRows(db, MARU.id).filter((row) =>
      row.field.startsWith('title_ruby'),
    );
    expect(rubyTextRows).toEqual([]);

    // But each reading field IS present in search_tokens at weight 3.
    expect(tokenWeight(db, 'title_ruby')).toBe(3);
    expect(tokenWeight(db, 'title_ruby_romaji')).toBe(3);
    expect(tokenWeight(db, 'title_ruby_hangul')).toBe(3);
    expect(tokenExists(db, 'term', 'maru', 'title_ruby_romaji')).toBe(true);
    expect(tokenExists(db, 'term', 'マル', 'title_ruby')).toBe(true);
    expect(tokenExists(db, 'term', '마루', 'title_ruby_hangul')).toBe(true);
  });

  it('romaji field emits term+prefix only (no dead ASCII grams); kana/hangul keep grams', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU]);

    // Romaji is ASCII; the worker never emits ASCII gram query tokens, so grams
    // would be dead weight — assert they are absent.
    expect(tokenKinds(db, 'title_ruby_romaji')).toEqual(['prefix', 'term']);
    // Katakana + hangul readings keep substring (gram) recall.
    expect(tokenExists(db, 'gram2', 'マル', 'title_ruby')).toBe(true);
    expect(tokenExists(db, 'gram2', '마루', 'title_ruby_hangul')).toBe(true);
  });

  it('emits no choseong initial tokens for any reading field (parity with offline layer)', () => {
    const db = openMemoryDb();
    importSongs(db, [MARU]);
    expect(tokenKinds(db, 'title_ruby_hangul')).not.toContain('initial');
  });

  it('indexes no reading tokens for a record without a ruby', () => {
    const db = openMemoryDb();
    importSongs(db, [NO_RUBY]);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM search_tokens WHERE field LIKE 'title_ruby%'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });
});

/**
 * Cross-field dedup (R4 a′+): a reading never re-emits a (kind, token) the
 * song's own canonical title/artist fields already produced, so a redundant
 * ruby cannot double-count a canonical match.
 */
describe('title_ruby cross-field token dedup', () => {
  function makeRuby(id: string, title: string, ruby: string): SongRecord {
    return {
      id,
      source_url: `https://example.com/${id}`,
      title_primary: title,
      title_ko: null,
      artist_primary: 'Artist',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: id.replace(/\D/g, '') || '1' },
      crawled_at: '2026-02-01T00:00:00.000Z',
      title_ruby: ruby,
    };
  }

  function fieldTokenCount(db: SongDatabase, field: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS c FROM search_tokens WHERE field = ?').get(field) as {
        c: number;
      }
    ).c;
  }

  it('kana title whose ruby equals it: kana title_ruby fully deduped, but romaji/hangul remain (novel)', () => {
    const db = openMemoryDb();
    importSongs(db, [makeRuby('joysound-201', 'マル', 'マル')]);
    // Every kana token the ruby would emit is already produced by title_primary
    // 'マル' → the kana reading field contributes nothing (no double-count).
    expect(fieldTokenCount(db, 'title_ruby')).toBe(0);
    // Romaji + hangul are derived scripts the kana title never produced, so they
    // are novel recall and kept (a kana title becomes findable by maru / 마루).
    expect(tokenExists(db, 'term', 'maru', 'title_ruby_romaji')).toBe(true);
    expect(tokenExists(db, 'term', '마루', 'title_ruby_hangul')).toBe(true);
  });

  it('kanji title: reading shares nothing with the title, so full reading tokens are kept', () => {
    const db = openMemoryDb();
    importSongs(db, [makeRuby('joysound-202', '丸', 'マル')]);
    expect(tokenExists(db, 'term', 'マル', 'title_ruby')).toBe(true);
    expect(tokenExists(db, 'gram2', 'マル', 'title_ruby')).toBe(true);
    expect(tokenExists(db, 'term', 'maru', 'title_ruby_romaji')).toBe(true);
  });

  it('partial overlap: only the tokens the title lacks survive on the kana reading field', () => {
    const db = openMemoryDb();
    // title 'マル' emits gram2 'マル'; ruby 'マルコ' emits term 'マルコ' (novel) plus
    // gram2 'マル' (overlaps title → deduped) and gram2 'ルコ' (novel → kept).
    importSongs(db, [makeRuby('joysound-203', 'マル', 'マルコ')]);
    expect(tokenExists(db, 'term', 'マルコ', 'title_ruby')).toBe(true);
    expect(tokenExists(db, 'gram2', 'ルコ', 'title_ruby')).toBe(true);
    expect(tokenExists(db, 'gram2', 'マル', 'title_ruby')).toBe(false);
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
