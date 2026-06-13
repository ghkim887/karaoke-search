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
    crawled_at: '2026-01-08T00:00:00.000Z',
  },
];

const PROVIDER_PRIORITY_RECORDS: SongRecord[] = [
  {
    id: 'rank-joy-1',
    source_url: 'https://example.com/rank/joy',
    title_primary: 'Provider Priority Song',
    title_ko: null,
    artist_primary: 'Priority Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '610001' },
    crawled_at: '2026-06-13T00:00:00.000Z',
  },
  {
    id: 'rank-ky-1',
    source_url: 'https://example.com/rank/ky',
    title_primary: 'Provider Priority Song',
    title_ko: null,
    artist_primary: 'Priority Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: '22222', joysound: null },
    crawled_at: '2026-06-13T00:00:00.000Z',
  },
  {
    id: 'rank-tj-1',
    source_url: 'https://example.com/rank/tj',
    title_primary: 'Provider Priority Song',
    title_ko: null,
    artist_primary: 'Priority Artist',
    artist_ko: null,
    karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    crawled_at: '2026-06-13T00:00:00.000Z',
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
    const byIndexedFilters = await fetchJson(db, '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=tj');
    const byMismatchedIndexedFilters = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=ky',
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

  it('ranks search matches by provider availability: TJ first, then KY, then JOY', async () => {
    const db = createD1WithSongs(PROVIDER_PRIORITY_RECORDS);

    const result = await fetchJson(db, '/api/search?q=provider%20priority');

    expect(result.items.map((song) => song.id)).toEqual(['rank-tj-1', 'rank-ky-1', 'rank-joy-1']);
  });

  it('serves three-or-more-character Hangul initial prefixes without internal errors', async () => {
    const db = createD1WithSongs(MINISEARCH_PARITY_RECORDS);

    const byArtistInitial = await fetchJson(db, '/api/search?q=%E3%84%B9%E3%84%B7%E3%85%87');
    const byTitleInitial = await fetchJson(db, '/api/search?q=%E3%85%85%E3%85%8D%E3%85%8B');

    expect(byArtistInitial.items.map((song) => song.id)).toEqual(['parity-radwimps-1']);
    expect(byTitleInitial.items.map((song) => song.id)).toEqual(['parity-radwimps-1']);
  });

  it('applies vendor filters', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const withTj = await fetchJson(db, '/api/search?vendor=tj');
    const withKy = await fetchJson(db, '/api/search?vendor=ky');

    expect(withTj.items.map((song) => song.id)).toEqual(['song-1', 'song-2', 'song-4']);
    expect(withKy.items.map((song) => song.id)).toEqual(['song-3']);
  });

  it('applies vendor filters while using the derived search index', async () => {
    const statements: string[] = [];
    const db = createD1WithSongs(FIXTURE_RECORDS, {
      inspectStatement: (sql) => statements.push(sql),
    });

    const withTj = await fetchJson(db, '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=tj');
    const withKy = await fetchJson(db, '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=ky');

    expect(withTj.items.map((song) => song.id)).toEqual(['song-4']);
    expect(withKy.items).toEqual([]);

    const indexedSql = statements.find((sql) => sql.includes('FROM search_tokens st'));
    expect(indexedSql).toBeDefined();
    expect(indexedSql).not.toMatch(/\.category\b/);
    expect(indexedSql).toMatch(/\(st\.provider_mask & \?\) != 0/);
  });

  it('applies a multi-vendor filter as the union of the selected vendors', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    // song-1/song-2/song-4 are tj-tagged, song-3 is ky-only.
    const withTjKy = await fetchJson(db, '/api/search?vendor=tj,ky');
    const withKyJoysound = await fetchJson(db, '/api/search?vendor=ky,joysound');

    expect(withTjKy.items.map((song) => song.id)).toEqual(['song-1', 'song-2', 'song-3', 'song-4']);
    // song-1 (joysound) + song-3 (ky) + song-4 (joysound); song-2 is tj-only and excluded.
    expect(withKyJoysound.items.map((song) => song.id)).toEqual(['song-1', 'song-3', 'song-4']);
  });

  it('keeps single-vendor filtering working for back-compat', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const withJoysound = await fetchJson(db, '/api/search?vendor=joysound');

    expect(withJoysound.items.map((song) => song.id)).toEqual(['song-1', 'song-4']);
  });

  it('ORs the multi-vendor bitmask in the derived search index path', async () => {
    const statements: { sql: string; parameters: readonly (string | number | null)[] }[] = [];
    const db = createD1WithSongs(FIXTURE_RECORDS, {
      inspectStatement: (sql, parameters) => statements.push({ sql, parameters }),
    });

    const withTjKy = await fetchJson(db, '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=tj,ky');

    expect(withTjKy.items.map((song) => song.id)).toEqual(['song-4']);

    const indexed = statements.find((entry) => entry.sql.includes('FROM search_tokens st'));
    expect(indexed).toBeDefined();
    // Each index filter contributes a SINGLE combined-mask comparison (ORed via
    // the bitmask), never one clause per selected vendor.
    expect(indexed?.sql).toMatch(/\(st\.provider_mask & \?\) != 0/);
    expect(indexed?.sql).not.toMatch(/provider_mask & \? != 0[\s\S]*OR[\s\S]*provider_mask & \?/);
    // tj (1) | ky (2) === 3 should be bound as the combined mask.
    expect(indexed?.parameters).toContain(3);
  });

  it('ORs the multi-vendor set in the karaoke-number candidate path', async () => {
    const statements: { sql: string; parameters: readonly (string | number | null)[] }[] = [];
    const db = createD1WithSongs(FIXTURE_RECORDS, {
      inspectStatement: (sql, parameters) => statements.push({ sql, parameters }),
    });

    // song-4 carries tj 068748; restrict to a vendor set that includes tj.
    const withTjKy = await fetchJson(db, '/api/search?q=68748&vendor=tj,ky');
    // ky alone must not surface a tj-only number.
    const withKyOnly = await fetchJson(db, '/api/search?q=68748&vendor=ky');

    expect(withTjKy.items.map((song) => song.id)).toEqual(['song-4']);
    expect(withKyOnly.items).toEqual([]);

    const candidateSql = statements.find((entry) => entry.sql.includes('FROM karaoke_numbers kn'));
    expect(candidateSql).toBeDefined();
    expect(candidateSql?.sql).toMatch(/kn\.provider IN \(\?(, \?)+\)/);
  });

  it('rejects an invalid vendor member inside a multi-vendor filter with HTTP 400', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const response = await handleRequest(
      new Request('https://karaoke.example/api/search?vendor=tj,nope'),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid vendor: nope' });
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
      new Request('https://karaoke.example/api/search?vendor=invalid'),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid vendor: invalid' });
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
    expect(candidateSql).not.toMatch(/kn\.number\s*=\s*\?\s+OR\s+kn\.number_key\s*=\s*\?/i);
    expect(candidateSql?.match(/FROM karaoke_numbers kn/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
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

describe('worker batch-by-id API', () => {
  it('hydrates full records (numbers + aliases) for the requested ids', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const result = await fetchJson(db, '/api/songs?ids=song-1,song-4');

    const byId = new Map(result.items.map((song) => [song.id, song]));
    expect([...byId.keys()].sort()).toEqual(['song-1', 'song-4']);
    expect(byId.get('song-1')).toEqual(FIXTURE_RECORDS[0]);
    expect(byId.get('song-4')).toEqual(FIXTURE_RECORDS[3]);
    // Aliases + karaoke numbers must be populated by the shared hydrator.
    expect(byId.get('song-1')?.artist_aliases).toEqual(['Yoa Alias']);
    expect(byId.get('song-4')?.karaoke_numbers).toEqual({
      tj: '068748',
      ky: null,
      joysound: '613446',
    });
  });

  it('tolerates missing ids by returning only the records that exist', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const result = await fetchJson(db, '/api/songs?ids=song-2,does-not-exist,song-3');

    expect(result.items.map((song) => song.id).sort()).toEqual(['song-2', 'song-3']);
  });

  it('returns 400 when the ids parameter is empty or absent', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const missing = await handleRequest(new Request('https://karaoke.example/api/songs'), {
      DB: db,
    });
    const empty = await handleRequest(new Request('https://karaoke.example/api/songs?ids='), {
      DB: db,
    });
    const blank = await handleRequest(
      new Request('https://karaoke.example/api/songs?ids=%20,%20'),
      { DB: db },
    );

    expect(missing.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(blank.status).toBe(400);
  });

  it('returns 400 when more than the per-request id cap is requested', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);
    const oversized = Array.from({ length: 101 }, (_, index) => `song-${index}`).join(',');

    const response = await handleRequest(
      new Request(`https://karaoke.example/api/songs?ids=${oversized}`),
      { DB: db },
    );

    expect(response.status).toBe(400);
  });

  it('serves exactly the per-request id cap without error', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);
    const ids = ['song-1', ...Array.from({ length: 99 }, (_, index) => `absent-${index}`)].join(
      ',',
    );

    const result = await fetchJson(db, `/api/songs?ids=${ids}`);

    expect(result.items.map((song) => song.id)).toEqual(['song-1']);
  });

  it('binds ids as parameters with no SQL-injection surface', async () => {
    const statements: { sql: string; parameters: readonly (string | number | null)[] }[] = [];
    const db = createD1WithSongs(FIXTURE_RECORDS, {
      inspectStatement: (sql, parameters) => statements.push({ sql, parameters }),
    });

    // No comma inside the payload so it stays a single literal id after parsing.
    const injection = "song-1' OR '1'='1'; DROP TABLE songs;--";
    const result = await fetchJson(db, `/api/songs?ids=${encodeURIComponent(injection)},song-2`);

    // The injection string is treated as a literal id (no such song); song-2 is found.
    expect(result.items.map((song) => song.id)).toEqual(['song-2']);

    const songsLookup = statements.find(
      (entry) => entry.sql.includes('FROM songs') && /\bid IN \(\?(, \?)*\)/.test(entry.sql),
    );
    expect(songsLookup).toBeDefined();
    // The dangerous string must appear ONLY as a bound parameter, never in the SQL text.
    expect(songsLookup?.sql).not.toContain('DROP TABLE');
    expect(songsLookup?.parameters).toContain(injection);

    // The songs table must still be intact afterward.
    const stillThere = await fetchJson(db, '/api/songs?ids=song-1');
    expect(stillThere.items.map((song) => song.id)).toEqual(['song-1']);
  });

  it('rejects non-GET methods on the batch endpoint', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const response = await handleRequest(
      new Request('https://karaoke.example/api/songs?ids=song-1', { method: 'POST' }),
      { DB: db },
    );

    expect(response.status).toBe(405);
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
