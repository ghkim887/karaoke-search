import {
  type ImportSongsOptions,
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
  importOptions: ImportSongsOptions = {},
): D1DatabaseLike {
  const sqlite = openSongDatabase(':memory:');
  openDatabases.push(sqlite);
  createSongDatabase(sqlite);
  importSongs(sqlite, records, importOptions);
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

const PROVIDER_ORDER_RECORDS: SongRecord[] = [
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

const EXACT_MATCH_TIER_RECORDS: SongRecord[] = [
  {
    id: 'exact-weak-tj-1',
    source_url: 'https://example.com/exact/weak-tj',
    title_primary: 'かなたのどこか',
    title_ko: null,
    artist_primary: 'Other Artist',
    artist_ko: null,
    karaoke_numbers: { tj: '11111', ky: null, joysound: null },
    crawled_at: '2026-06-14T00:00:00.000Z',
  },
  {
    id: 'exact-joy-artist-1',
    source_url: 'https://example.com/exact/joy-artist',
    title_primary: 'Knock it out!',
    title_ko: null,
    artist_primary: '天音かなた',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '817062' },
    crawled_at: '2026-06-14T00:00:00.000Z',
  },
];

// Records that share one searchable title but differ in provider coverage. Their
// insertion order intentionally disagrees with provider coverage so tests can
// prove vendor filters do not inject provider/coverage ranking.
const COVERAGE_RANK_RECORDS: SongRecord[] = [
  {
    id: 'cov-joy-only-1',
    source_url: 'https://example.com/cov/joy-only',
    title_primary: 'Coverage Rank Song',
    title_ko: null,
    artist_primary: 'Coverage Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '610001' },
    crawled_at: '2026-03-01T00:00:00.000Z',
  },
  {
    id: 'cov-ky-only-1',
    source_url: 'https://example.com/cov/ky-only',
    title_primary: 'Coverage Rank Song',
    title_ko: null,
    artist_primary: 'Coverage Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: '22222', joysound: null },
    crawled_at: '2026-03-02T00:00:00.000Z',
  },
  {
    id: 'cov-ky-tj-1',
    source_url: 'https://example.com/cov/ky-tj',
    title_primary: 'Coverage Rank Song',
    title_ko: null,
    artist_primary: 'Coverage Artist',
    artist_ko: null,
    karaoke_numbers: { tj: '12345', ky: '33333', joysound: null },
    crawled_at: '2026-03-03T00:00:00.000Z',
  },
  {
    id: 'cov-joy-tj-1',
    source_url: 'https://example.com/cov/joy-tj',
    title_primary: 'Coverage Rank Song',
    title_ko: null,
    artist_primary: 'Coverage Artist',
    artist_ko: null,
    karaoke_numbers: { tj: '67890', ky: null, joysound: '610002' },
    crawled_at: '2026-03-04T00:00:00.000Z',
  },
  {
    id: 'cov-all-1',
    source_url: 'https://example.com/cov/all',
    title_primary: 'Coverage Rank Song',
    title_ko: null,
    artist_primary: 'Coverage Artist',
    artist_ko: null,
    karaoke_numbers: { tj: '54321', ky: '44444', joysound: '610003' },
    crawled_at: '2026-03-05T00:00:00.000Z',
  },
];

// Kana-ONLY titles (deliberately not the kanji spellings 夜に駆ける / 紅蓮華):
// they exercise romaji→kana search recall without relying on any kanji reading.
const KANA_RECALL_RECORDS: SongRecord[] = [
  {
    id: 'kana-yoru-1',
    source_url: 'https://example.com/kana/yoru',
    title_primary: 'よるにかける',
    title_ko: null,
    artist_primary: 'YOASOBI',
    artist_ko: null,
    karaoke_numbers: { tj: '700001', ky: null, joysound: null },
    crawled_at: '2026-02-01T00:00:00.000Z',
  },
  {
    id: 'kana-gurenge-2',
    source_url: 'https://example.com/kana/gurenge',
    title_primary: 'ぐれんげ',
    title_ko: null,
    artist_primary: 'LiSA',
    artist_ko: null,
    karaoke_numbers: { tj: '700002', ky: null, joysound: null },
    crawled_at: '2026-02-02T00:00:00.000Z',
  },
];

describe('worker search API — romaji↔kana expansion (search recall only)', () => {
  it('finds a kana-only title from a Latin romaji query', async () => {
    const db = createD1WithSongs(KANA_RECALL_RECORDS);

    const byYoru = await fetchJson(db, `/api/search?q=${encodeURIComponent('yoru')}`);
    const byGurenge = await fetchJson(db, `/api/search?q=${encodeURIComponent('gurenge')}`);

    expect(byYoru.items.map((song) => song.id)).toContain('kana-yoru-1');
    expect(byGurenge.items.map((song) => song.id)).toContain('kana-gurenge-2');
  });

  it('preserves the original query: a direct kana query still matches', async () => {
    const db = createD1WithSongs(KANA_RECALL_RECORDS);

    const byKana = await fetchJson(db, `/api/search?q=${encodeURIComponent('よる')}`);

    expect(byKana.items.map((song) => song.id)).toContain('kana-yoru-1');
  });

  it('leaves numeric karaoke-number queries unexpanded', async () => {
    const db = createD1WithSongs(KANA_RECALL_RECORDS);

    const byNumber = await fetchJson(db, '/api/search?q=700001');

    expect(byNumber.items.map((song) => song.id)).toEqual(['kana-yoru-1']);
  });
});

// Kanji canonical titles whose kana READING is supplied only as a SEARCH hint
// (never written to the SongRecord). 夜に駆ける / 千本桜 are the canonical kanji
// spellings the JOYSOUND songNameRuby would accompany.
const KANJI_HINT_RECORDS: SongRecord[] = [
  {
    id: 'joysound-190001',
    source_url: 'https://example.com/joysound/190001',
    title_primary: '夜に駆ける',
    title_ko: null,
    artist_primary: 'YOASOBI',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
    crawled_at: '2026-02-01T00:00:00.000Z',
  },
];

describe('worker search API — JOYSOUND ruby hints (search recall only)', () => {
  it('finds a kanji canonical title from a kana query via a ruby hint', async () => {
    const db = createD1WithSongs(
      KANJI_HINT_RECORDS,
      {},
      {
        searchHints: [
          {
            songId: 'joysound-190001',
            field: 'title',
            text: 'よるにかける',
            source: 'joysound_songNameRuby',
            confidence: 'high',
          },
        ],
      },
    );

    // The canonical title 夜に駆ける shares no characters with よる; the only path
    // to a match is the ruby hint's kana tokens.
    const byKana = await fetchJson(db, `/api/search?q=${encodeURIComponent('よる')}`);
    expect(byKana.items.map((song) => song.id)).toContain('joysound-190001');
    // The returned record must remain the canonical SongRecord (no hint leakage).
    expect(byKana.items[0]).toEqual(KANJI_HINT_RECORDS[0]);
  });

  it('finds a kanji canonical title from a romaji query via the derived romaji hint', async () => {
    const db = createD1WithSongs(
      KANJI_HINT_RECORDS,
      {},
      {
        searchHints: [
          {
            songId: 'joysound-190001',
            field: 'title',
            text: 'よるにかける',
            source: 'joysound_songNameRuby',
            confidence: 'high',
          },
        ],
      },
    );

    const byRomaji = await fetchJson(db, '/api/search?q=yorunikakeru');
    const byRomajiPrefix = await fetchJson(db, '/api/search?q=yoru');

    expect(byRomaji.items.map((song) => song.id)).toContain('joysound-190001');
    expect(byRomajiPrefix.items.map((song) => song.id)).toContain('joysound-190001');
  });

  it('does not surface the song for an unrelated kana query', async () => {
    const db = createD1WithSongs(
      KANJI_HINT_RECORDS,
      {},
      {
        searchHints: [
          {
            songId: 'joysound-190001',
            field: 'title',
            text: 'よるにかける',
            source: 'joysound_songNameRuby',
            confidence: 'high',
          },
        ],
      },
    );

    const byUnrelated = await fetchJson(db, `/api/search?q=${encodeURIComponent('さくら')}`);
    expect(byUnrelated.items.map((song) => song.id)).not.toContain('joysound-190001');
  });
});

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
    const bySingleKanji = await fetchJson(db, '/api/search?q=%E5%A4%A9');
    const byHangulInitial = await fetchJson(db, '/api/search?q=%E3%85%85%E3%84%B9');
    const byCompactAlias = await fetchJson(db, '/api/search?q=mrsgreenapple');
    const byProviderNumber = await fetchJson(db, '/api/search?q=TJ068748');
    const byIndexedFilters = await fetchJson(db, '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=tj');
    const byMismatchedIndexedFilters = await fetchJson(
      db,
      '/api/search?q=%E5%A4%A9%E4%BD%BF&vendor=ky',
    );

    expect(byJapaneseGram.items.map((song) => song.id)).toEqual(['song-4']);
    expect(bySingleKanji.items.map((song) => song.id)).toEqual(['song-4']);
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

  it('does not reorder equal-relevance matches by provider availability', async () => {
    const db = createD1WithSongs(PROVIDER_ORDER_RECORDS);

    const result = await fetchJson(db, '/api/search?q=provider%20priority');

    expect(result.items.map((song) => song.id)).toEqual(['rank-joy-1', 'rank-ky-1', 'rank-tj-1']);
  });

  it('ranks exact text matches above weak token matches without applying provider priority', async () => {
    const db = createD1WithSongs(EXACT_MATCH_TIER_RECORDS);

    const result = await fetchJson(db, `/api/search?q=${encodeURIComponent('天音かなた')}`);

    expect(result.items.map((song) => song.id)).toEqual(['exact-joy-artist-1', 'exact-weak-tj-1']);
  });

  it('filters a vendor-selected search without provider coverage reranking (vendor=joysound)', async () => {
    const db = createD1WithSongs(COVERAGE_RANK_RECORDS);

    const result = await fetchJson(db, '/api/search?q=coverage&vendor=joysound');

    expect(result.items.map((song) => song.id)).toEqual([
      'cov-joy-only-1',
      'cov-joy-tj-1',
      'cov-all-1',
    ]);
  });

  it('filters a vendor-selected search without provider coverage reranking (vendor=ky)', async () => {
    const db = createD1WithSongs(COVERAGE_RANK_RECORDS);

    const result = await fetchJson(db, '/api/search?q=coverage&vendor=ky');

    expect(result.items.map((song) => song.id)).toEqual([
      'cov-ky-only-1',
      'cov-ky-tj-1',
      'cov-all-1',
    ]);
  });

  it('filters a multi-vendor search without provider coverage reranking (vendor=tj,joysound)', async () => {
    const db = createD1WithSongs(COVERAGE_RANK_RECORDS);

    const result = await fetchJson(db, '/api/search?q=coverage&vendor=tj,joysound');
    const ids = result.items.map((song) => song.id);
    // ky-only record is filtered out (no tj/joysound number).
    expect(ids).not.toContain('cov-ky-only-1');
    expect(ids).toEqual(['cov-joy-only-1', 'cov-ky-tj-1', 'cov-joy-tj-1', 'cov-all-1']);
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

    // Union membership is preserved without provider/coverage reranking.
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

  it('returns prefix matches for numeric queries longer than the former 50-byte D1 LIKE limit', async () => {
    // The prefix pattern `${longPrefix}%` is 52 bytes, which the removed D1 gate
    // used to drop, silently skipping the prefix subquery and losing this record.
    const longPrefix = '1'.repeat(51);
    const prefixMatchRecord: SongRecord = {
      id: 'long-number-prefix-1',
      source_url: 'https://example.com/long-number-prefix',
      title_primary: 'Long Number Prefix Song',
      title_ko: null,
      artist_primary: 'Long Number Artist',
      artist_ko: null,
      karaoke_numbers: { tj: `${longPrefix}23`, ky: null, joysound: null },
      crawled_at: '2026-01-09T00:00:00.000Z',
    };
    const db = createD1WithSongs([...FIXTURE_RECORDS, prefixMatchRecord]);
    const response = await handleRequest(
      new Request(`https://karaoke.example/api/search?q=${longPrefix}`),
      {
        DB: db,
      },
    );

    // The stored number (`${longPrefix}23`) never equals the query, so only the
    // LIKE prefix subquery can surface it — proving the length gate is gone.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [prefixMatchRecord],
      nextCursor: null,
    });
  });

  it('still resolves numeric queries longer than the former 50-byte D1 LIKE limit by exact match', async () => {
    const longNumber = '1'.repeat(51);
    const longNumberRecord: SongRecord = {
      id: 'long-number-exact-1',
      source_url: 'https://example.com/long-number-exact',
      title_primary: 'Long Number Song',
      title_ko: null,
      artist_primary: 'Long Number Artist',
      artist_ko: null,
      karaoke_numbers: { tj: longNumber, ky: null, joysound: null },
      crawled_at: '2026-01-09T00:00:00.000Z',
    };
    const db = createD1WithSongs([...FIXTURE_RECORDS, longNumberRecord]);
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
