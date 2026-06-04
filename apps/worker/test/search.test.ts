import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type D1DatabaseLike, handleRequest } from '../src/index.js';
import { SqliteD1Database, type SqliteD1Options } from '../src/sqlite-adapter.js';

const openDatabases: SongDatabase[] = [];

interface NodeSqliteD1Options extends SqliteD1Options {}

function createD1WithSongs(
  records: readonly SongRecord[],
  options: NodeSqliteD1Options = {},
): D1DatabaseLike {
  const sqlite = openSongDatabase(':memory:');
  openDatabases.push(sqlite);
  createSongDatabase(sqlite);
  importSongs(sqlite, records);
  return new SqliteD1Database(sqlite, options);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'song-1',
    source_url: 'https://example.com/1',
    title_primary: 'Idol',
    title_ko: 'Idol Korean',
    artist_primary: 'YOASOBI',
    artist_ko: null,
    artist_aliases: ['Yoa Alias'],
    karaoke_numbers: { tj: '12345', ky: null, joysound: '999001' },
    categories: ['jpop'],
    crawled_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'song-2',
    source_url: 'https://example.com/2',
    title_primary: 'Kick Back',
    title_ko: null,
    artist_primary: 'Kenshi Yonezu',
    artist_ko: null,
    karaoke_numbers: { tj: '67890', ky: null, joysound: null },
    categories: ['anime'],
    crawled_at: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'song-3',
    source_url: 'https://example.com/3',
    title_primary: 'Senbonzakura',
    title_ko: null,
    artist_primary: 'Kurousa P',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: '11111', joysound: null },
    categories: ['vocaloid'],
    crawled_at: '2026-01-03T00:00:00.000Z',
  },
  {
    id: 'song-4',
    source_url: 'https://example.com/4',
    title_primary: '残酷な天使のテーゼ',
    title_ko: '사랑했나봐',
    artist_primary: "B'z",
    artist_ko: '비즈',
    artist_aliases: ['Mrs. GREEN APPLE'],
    karaoke_numbers: { tj: '068748', ky: null, joysound: '613446' },
    categories: ['anime'],
    crawled_at: '2026-01-04T00:00:00.000Z',
  },
];

const MINISEARCH_PARITY_RECORDS: SongRecord[] = [
  {
    id: 'parity-kessoku-1',
    source_url: 'https://example.com/parity/kessoku',
    title_primary: '青春コンプレックス',
    title_ko: null,
    artist_primary: '結束バンド',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '610001' },
    categories: ['anime'],
    crawled_at: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 'parity-radwimps-1',
    source_url: 'https://example.com/parity/radwimps',
    title_primary: 'Sparkle',
    title_ko: '스파클',
    artist_primary: 'RADWIMPS',
    artist_ko: '래드윔프스',
    karaoke_numbers: { tj: '62466', ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-01-06T00:00:00.000Z',
  },
  {
    id: 'parity-deco-27',
    source_url: 'https://example.com/parity/deco27',
    title_primary: 'Ghost Rule',
    title_ko: null,
    artist_primary: 'DECO*27',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: '44000', joysound: null },
    categories: ['vocaloid'],
    crawled_at: '2026-01-07T00:00:00.000Z',
  },
  {
    id: 'parity-higedan-1',
    source_url: 'https://example.com/parity/higedan',
    title_primary: 'Pretender',
    title_ko: null,
    artist_primary: 'Official髭男dism',
    artist_ko: null,
    artist_aliases: ['Official HIGE DANdism'],
    karaoke_numbers: { tj: '62500', ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-01-08T00:00:00.000Z',
  },
];

describe('worker search API', () => {
  it('returns matching songs from title, artist, alias, and karaoke number fields', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const byArtist = await fetchJson(db, '/api/search?q=yoasobi');
    const byAlias = await fetchJson(db, '/api/search?q=Yoa%20Alias');
    const byNumber = await fetchJson(db, '/api/search?q=67890');

    expect(byArtist.items.map((song) => song.id)).toEqual(['song-1']);
    expect(byAlias.items.map((song) => song.id)).toEqual(['song-1']);
    expect(byNumber.items.map((song) => song.id)).toEqual(['song-2']);
    expect(byArtist.items[0]).toEqual(FIXTURE_RECORDS[0]);
  });

  it('uses derived search indexes for compact aliases, CJK grams, Hangul initials, and provider numbers', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const byJapaneseGram = await fetchJson(db, '/api/search?q=%E5%A4%A9%E4%BD%BF');
    const byHangulInitial = await fetchJson(db, '/api/search?q=%E3%85%85%E3%84%B9');
    const byCompactAlias = await fetchJson(db, '/api/search?q=mrsgreenapple');
    const byProviderNumber = await fetchJson(db, '/api/search?q=TJ068748');
    const byIndexedFilters = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&category=anime&vendor=tj',
    );
    const byMismatchedIndexedFilters = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&category=anime&vendor=ky',
    );

    expect(byJapaneseGram.items.map((song) => song.id)).toEqual(['song-4']);
    expect(byHangulInitial.items.map((song) => song.id)).toEqual(['song-4']);
    expect(byCompactAlias.items.map((song) => song.id)).toEqual(['song-4']);
    expect(byProviderNumber.items.map((song) => song.id)).toEqual(['song-4']);
    expect(byIndexedFilters.items.map((song) => song.id)).toEqual(['song-4']);
    expect(byMismatchedIndexedFilters.items).toEqual([]);
  });

  it('preserves MiniSearch parity for Japanese artist, Latin casefolding, punctuation prefixes, and long prefixes', async () => {
    const db = createD1WithSongs(MINISEARCH_PARITY_RECORDS);

    const byJapaneseArtist = await fetchJson(
      db,
      '/api/search?q=%E7%B5%90%E6%9D%9F%E3%83%90%E3%83%B3%E3%83%89',
    );
    const byLatinCasefold = await fetchJson(db, '/api/search?q=radwimps');
    const byPunctuationPrefix = await fetchJson(db, '/api/search?q=DECO');
    const byLongPrefix = await fetchJson(db, '/api/search?q=officialhigedan');

    expect(byJapaneseArtist.items.map((song) => song.id)).toEqual(['parity-kessoku-1']);
    expect(byLatinCasefold.items.map((song) => song.id)).toEqual(['parity-radwimps-1']);
    expect(byPunctuationPrefix.items.map((song) => song.id)).toEqual(['parity-deco-27']);
    expect(byLongPrefix.items.map((song) => song.id)).toEqual(['parity-higedan-1']);
  });

  it('serves three-or-more-character Hangul initial prefixes without internal errors', async () => {
    const db = createD1WithSongs(MINISEARCH_PARITY_RECORDS);

    const byArtistInitial = await fetchJson(db, '/api/search?q=%E3%84%B9%E3%84%B7%E3%85%87');
    const byTitleInitial = await fetchJson(db, '/api/search?q=%E3%85%85%E3%85%8D%E3%85%8B');

    expect(byArtistInitial.items.map((song) => song.id)).toEqual(['parity-radwimps-1']);
    expect(byTitleInitial.items.map((song) => song.id)).toEqual(['parity-radwimps-1']);
  });

  it('applies category and vendor filters', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const animeWithTj = await fetchJson(db, '/api/search?category=anime&vendor=tj');
    const animeWithKy = await fetchJson(db, '/api/search?category=anime&vendor=ky');

    expect(animeWithTj.items.map((song) => song.id)).toEqual(['song-2', 'song-4']);
    expect(animeWithKy.items).toEqual([]);
  });

  it('applies category and vendor filters while using the derived search index', async () => {
    const statements: string[] = [];
    const db = createD1WithSongs(FIXTURE_RECORDS, {
      inspectStatement: (sql) => statements.push(sql),
    });

    const animeWithTj = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&category=anime&vendor=tj',
    );
    const animeWithKy = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&category=anime&vendor=ky',
    );
    const vocaloidWithTj = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&category=vocaloid&vendor=tj',
    );

    expect(animeWithTj.items.map((song) => song.id)).toEqual(['song-4']);
    expect(animeWithKy.items).toEqual([]);
    expect(vocaloidWithTj.items).toEqual([]);

    const indexedSql = statements.find((sql) => sql.includes('FROM search_tokens st'));
    expect(indexedSql).toBeDefined();
    expect(indexedSql).toMatch(/st\.category = \?/);
    expect(indexedSql).toMatch(/\(st\.provider_mask & \?\) != 0/);
  });

  it('paginates using limit and cursor without dropping result order', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const first = await fetchJson(db, '/api/search?limit=2');
    const second = await fetchJson(db, `/api/search?limit=2&cursor=${first.nextCursor}`);

    expect(first.items.map((song) => song.id)).toEqual(['song-1', 'song-2']);
    expect(first.nextCursor).toBe('2');
    expect(second.items.map((song) => song.id)).toEqual(['song-3', 'song-4']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects invalid filters with HTTP 400', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const response = await handleRequest(
      new Request('https://karaoke.example/api/search?category=invalid'),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid category: invalid' });
  });

  it('accepts long search queries without D1 LIKE-pattern failures', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);
    const response = await handleRequest(
      new Request(`https://karaoke.example/api/search?q=${'a'.repeat(49)}`),
      { DB: db },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('does not bind oversized D1 LIKE patterns while preserving long numeric exact search', async () => {
    const longNumber = '1'.repeat(50);
    const longNumberRecord: SongRecord = {
      id: 'long-number-1',
      source_url: 'https://example.com/long-number',
      title_primary: 'Long Number Song',
      title_ko: null,
      artist_primary: 'Long Number Artist',
      artist_ko: null,
      karaoke_numbers: { tj: longNumber, ky: null, joysound: null },
      categories: ['jpop'],
      crawled_at: '2026-01-09T00:00:00.000Z',
    };
    const db = createD1WithSongs([...FIXTURE_RECORDS, longNumberRecord], {
      enforceD1SuffixLikePatternLimit: true,
    });
    const response = await handleRequest(
      new Request(`https://karaoke.example/api/search?q=${longNumber}`),
      {
        DB: db,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [longNumberRecord],
      nextCursor: null,
    });
  });

  it('splits numeric lookup branches so exact and prefix predicates remain indexable', async () => {
    const statements: string[] = [];
    const db = createD1WithSongs(FIXTURE_RECORDS, {
      inspectStatement: (sql) => statements.push(sql),
    });

    const byNumber = await fetchJson(db, '/api/search?q=68748');

    expect(byNumber.items.map((song) => song.id)).toEqual(['song-4']);
    const candidateSql = statements.find((sql) => sql.includes('FROM karaoke_numbers kn'));
    expect(candidateSql).toBeDefined();
    expect(candidateSql).not.toMatch(/\bLTRIM\s*\(/i);
    expect(candidateSql).not.toMatch(/\bLIKE\b/i);
    expect(candidateSql).not.toMatch(/kn\.number\s*=\s*\?\s+OR\s+kn\.number_key\s*=\s*\?/i);
    expect(candidateSql).toContain('kn.number = ?');
    expect(candidateSql).toContain('kn.number_key = ?');
    expect(candidateSql).toContain('kn.number >= ? AND kn.number < ?');
    expect(candidateSql).toContain('kn.number_key >= ? AND kn.number_key < ?');
    expect(candidateSql?.match(/FROM karaoke_numbers kn/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('serves all-9 numeric prefixes through the indexed range path', async () => {
    const ninesRecord: SongRecord = {
      id: 'nines-prefix-1',
      source_url: 'https://example.com/nines-prefix',
      title_primary: 'Nines Prefix Song',
      title_ko: null,
      artist_primary: 'Nines Prefix Artist',
      artist_ko: null,
      karaoke_numbers: { tj: '999123', ky: null, joysound: null },
      categories: ['jpop'],
      crawled_at: '2026-01-10T00:00:00.000Z',
    };
    const adjacentRecord: SongRecord = {
      ...ninesRecord,
      id: 'adjacent-prefix-1',
      source_url: 'https://example.com/adjacent-prefix',
      title_primary: 'Adjacent Prefix Song',
      karaoke_numbers: { tj: '998999', ky: null, joysound: null },
    };
    const db = createD1WithSongs([...FIXTURE_RECORDS, ninesRecord, adjacentRecord]);

    const byNinesPrefix = await fetchJson(db, '/api/search?q=TJ999');

    expect(byNinesPrefix.items.map((song) => song.id)).toEqual(['nines-prefix-1']);
  });

  it('rejects unsafe cursor offsets', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);
    const response = await handleRequest(
      new Request('https://karaoke.example/api/search?cursor=9007199254740992'),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid cursor: 9007199254740992',
    });
  });

  it('returns 404 for non-API routes', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const response = await handleRequest(new Request('https://karaoke.example/not-found'), {
      DB: db,
    });

    expect(response.status).toBe(404);
  });
});

async function fetchJson(db: D1DatabaseLike, path: string): Promise<SearchResponseBody> {
  const response = await handleRequest(new Request(`https://karaoke.example${path}`), { DB: db });
  expect(response.status).toBe(200);
  return (await response.json()) as SearchResponseBody;
}

interface SearchResponseBody {
  items: SongRecord[];
  nextCursor: string | null;
}
