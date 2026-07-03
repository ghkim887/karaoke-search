import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { featured, featuredArtistLabel, featuredArtistQuery } from '../data/featured.js';
import * as searchModule from './search.js';
import { buildIndex } from './search.js';

const fixtureUrl = new URL(
  '../../../../packages/crawler/test/fixtures/songs.sample.json',
  import.meta.url,
);
const records = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')) as SongRecord[];

function makeSearchRecord(overrides: Partial<SongRecord> & Pick<SongRecord, 'id'>): SongRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    source_url: 'https://example.test/search-priority',
    title_primary: 'Search Priority Song',
    title_ko: null,
    artist_primary: 'Priority Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    crawled_at: '2026-06-13T00:00:00.000Z',
    ...rest,
  };
}

describe('search index (sample fixture)', () => {
  it('matches Japanese-script artist query "結束バンド"', () => {
    const index = buildIndex(records);
    const hits = index.search('結束バンド');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const top = hits[0];
    expect(top).toBeDefined();
    expect(['sample-0', 'sample-1']).toContain(top?.id);
  });

  it('casefolds Latin queries: "radwimps" matches "RADWIMPS"', () => {
    const index = buildIndex(records);
    const hits = index.search('radwimps');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ids = hits.map((h) => h.id);
    expect(ids.some((id) => id === 'sample-4' || id === 'sample-5')).toBe(true);
  });

  it('prefix-matches "DECO" against "DECO*27"', () => {
    const index = buildIndex(records);
    const hits = index.search('DECO');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ids = hits.map((h) => h.id);
    expect(ids.some((id) => id === 'sample-8' || id === 'sample-9')).toBe(true);
  });
});

describe('searchLocalIndex — romaji↔kana expansion (offline fallback recall)', () => {
  it('finds a kana-only title from a Latin romaji query', () => {
    const index = buildIndex([
      makeSearchRecord({ id: 'kana-yoru', title_primary: 'よるにかける' }),
      makeSearchRecord({ id: 'kana-gurenge', title_primary: 'ぐれんげ' }),
    ]);

    const byYoru = searchModule.searchLocalIndex(index, 'yoru').map((hit) => String(hit.id));
    const byGurenge = searchModule.searchLocalIndex(index, 'gurenge').map((hit) => String(hit.id));

    expect(byYoru).toContain('kana-yoru');
    expect(byGurenge).toContain('kana-gurenge');
  });

  it('merges duplicate hits by id', () => {
    const index = buildIndex([
      makeSearchRecord({ id: 'kana-yoru', title_primary: 'よるにかける' }),
    ]);

    const ids = searchModule.searchLocalIndex(index, 'yoru').map((hit) => String(hit.id));

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('biases an exact original-query hit above an expansion-only hit', () => {
    // "yoru" matches "Yoru" directly (original) and "よるにかける" via expansion.
    const index = buildIndex([
      makeSearchRecord({ id: 'kana-only', title_primary: 'よるにかける' }),
      makeSearchRecord({ id: 'latin-yoru', title_primary: 'Yoru' }),
    ]);

    const ids = searchModule.searchLocalIndex(index, 'yoru').map((hit) => String(hit.id));

    expect(ids).toContain('latin-yoru');
    expect(ids).toContain('kana-only');
    expect(ids.indexOf('latin-yoru')).toBeLessThan(ids.indexOf('kana-only'));
  });

  it('still matches an exact query when no expansion applies (kanji)', () => {
    const index = buildIndex([makeSearchRecord({ id: 'kanji-1', title_primary: '天使' })]);

    const ids = searchModule.searchLocalIndex(index, '天使').map((hit) => String(hit.id));

    expect(ids).toContain('kanji-1');
  });
});

describe('searchLocalIndex — offline number & initials recall (T6-1)', () => {
  it('routes a karaoke-number query to the number path', () => {
    const index = buildIndex([
      makeSearchRecord({
        id: 'num-hit',
        karaoke_numbers: { tj: '68381', ky: null, joysound: null },
      }),
      makeSearchRecord({
        id: 'num-miss',
        karaoke_numbers: { tj: '99999', ky: null, joysound: null },
      }),
    ]);

    const ids = searchModule.searchLocalIndex(index, '68381').map((hit) => String(hit.id));

    expect(ids).toEqual(['num-hit']);
  });

  it('scopes number matches to the vendors option', () => {
    const index = buildIndex([
      makeSearchRecord({ id: 'tj', karaoke_numbers: { tj: '68381', ky: null, joysound: null } }),
      makeSearchRecord({ id: 'ky', karaoke_numbers: { tj: null, ky: '68381', joysound: null } }),
    ]);

    const ids = searchModule
      .searchLocalIndex(index, '68381', { vendors: new Set(['ky']) })
      .map((hit) => String(hit.id));

    expect(ids).toEqual(['ky']);
  });

  it('routes an all-choseong query to the initials path', () => {
    const index = buildIndex([
      makeSearchRecord({ id: 'yoru', title_primary: '夜に駆ける', title_ko: '밤을 달리다' }),
    ]);

    const ids = searchModule.searchLocalIndex(index, 'ㅂㅇ').map((hit) => String(hit.id));

    expect(ids).toEqual(['yoru']);
  });

  it('leaves a plain text query on the MiniSearch path (recall paths do not fire)', () => {
    const index = buildIndex([makeSearchRecord({ id: 'text-1', title_primary: 'RADWIMPS' })]);

    // Byte-identical to the raw MiniSearch result for a non-number, non-initials query.
    const viaLocal = searchModule.searchLocalIndex(index, 'RADWIMPS').map((hit) => String(hit.id));
    const viaRaw = index.search('RADWIMPS').map((hit) => String(hit.id));

    expect(viaLocal).toEqual(viaRaw);
    expect(viaLocal).toContain('text-1');
  });
});

describe('search index — artist_aliases (spec 2026-05-04)', () => {
  function makeRecord(over: Partial<SongRecord>): SongRecord {
    return {
      id: 'alias-0',
      source_url: 'https://example.test/0',
      title_primary: 'Some Song',
      title_ko: null,
      artist_primary: 'ずっと真夜中でいいのに。',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      crawled_at: '2026-05-04T00:00:00Z',
      ...over,
    };
  }

  it('finds a record by its Latin alias when artist_aliases includes it ("ZUTOMAYO")', () => {
    const r = makeRecord({
      id: 'alias-1',
      artist_primary: 'ずっと真夜中でいいのに。',
      artist_aliases: ['ZUTOMAYO'],
    });
    const index = buildIndex([r]);
    const hits = index.search('ZUTOMAYO');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.id)).toContain('alias-1');
  });

  it('still finds the same record by its Japanese canonical name', () => {
    const r = makeRecord({
      id: 'alias-2',
      artist_primary: 'ずっと真夜中でいいのに。',
      artist_aliases: ['ZUTOMAYO'],
    });
    const index = buildIndex([r]);
    const hits = index.search('ずっと');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.id)).toContain('alias-2');
  });

  it('finds a record via a multi-character alias ("40meterP")', () => {
    const r = makeRecord({
      id: 'alias-3',
      artist_primary: '40mP',
      artist_aliases: ['40meterP'],
    });
    const index = buildIndex([r]);
    const hits = index.search('40meterP');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.id)).toContain('alias-3');
  });

  it('does NOT find a record by an unrelated alias when its artist_aliases is empty', () => {
    const r = makeRecord({
      id: 'alias-4',
      artist_primary: 'BUMP OF CHICKEN',
      // No artist_aliases.
    });
    const index = buildIndex([r]);
    const hits = index.search('Spitz');
    // No record carries the "Spitz" alias here — should NOT match.
    expect(hits.map((h) => h.id)).not.toContain('alias-4');
  });
});

describe('featured artist chips against the production corpus', () => {
  const productionRecords = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../public/data/songs.json', import.meta.url)), 'utf8'),
  ) as SongRecord[];
  it('keeps every featured artist pill wired to a query with real hits', () => {
    const index = buildIndex(productionRecords);
    for (const [section, artists] of Object.entries(featured)) {
      for (const artist of artists) {
        const query = featuredArtistQuery(artist);
        const label = featuredArtistLabel(artist);
        const hits = index.search(query);
        expect(
          hits.length,
          `${section} featured artist ${label} should search via ${query}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('API search client', () => {
  it('resolves a same-origin API base URL for Cloudflare Pages deployments', () => {
    expect(searchModule.resolveApiSearchBaseUrl('/', 'https://karaokedb.pages.dev')).toBe(
      'https://karaokedb.pages.dev',
    );
    expect(searchModule.resolveApiSearchBaseUrl('/karaoke-search/', 'https://example.test')).toBe(
      'https://example.test/karaoke-search',
    );
  });

  it('builds a /api/search request with filters and returns SongRecord items', async () => {
    const apiRecord = records[0];
    if (!apiRecord) throw new Error('fixture record missing');
    const requested: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ items: [apiRecord], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await searchModule.searchApi('https://api.example.test', {
      query: String.fromCodePoint(0x5929, 0x4f7f),
      vendor: 'tj',
      limit: 50,
      fetchImpl,
    });

    expect(result).toEqual([apiRecord]);
    expect(requested).toEqual([
      'https://api.example.test/api/search?q=%E5%A4%A9%E4%BD%BF&limit=50&vendor=tj',
    ]);
  });

  it('sends a comma-joined vendor param when multiple vendors are passed', async () => {
    const apiRecord = records[0];
    if (!apiRecord) throw new Error('fixture record missing');
    const requested: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ items: [apiRecord], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await searchModule.searchApi('https://api.example.test', {
      query: 'idol',
      vendors: ['tj', 'ky'],
      limit: 50,
      fetchImpl,
    });

    expect(result).toEqual([apiRecord]);
    expect(requested).toEqual([
      'https://api.example.test/api/search?q=idol&limit=50&vendor=tj%2Cky',
    ]);
  });

  it('treats a single-element vendors array like the singular vendor option', async () => {
    const apiRecord = records[0];
    if (!apiRecord) throw new Error('fixture record missing');
    const requested: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ items: [apiRecord], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await searchModule.searchApi('https://api.example.test', {
      query: 'idol',
      vendors: ['joysound'],
      limit: 50,
      fetchImpl,
    });

    expect(requested).toEqual([
      'https://api.example.test/api/search?q=idol&limit=50&vendor=joysound',
    ]);
  });
});

describe('fetchSongsByIds', () => {
  it('builds a /api/songs request with comma-joined encoded ids and parses items', async () => {
    const apiRecord = records[0];
    if (!apiRecord) throw new Error('fixture record missing');
    const requested: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ items: [apiRecord] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await searchModule.fetchSongsByIds(
      'https://api.example.test',
      ['a', 'b', 'c'],
      fetchImpl,
    );

    expect(result).toEqual([apiRecord]);
    expect(requested).toEqual(['https://api.example.test/api/songs?ids=a%2Cb%2Cc']);
  });

  it('returns an empty array without issuing a request when ids is empty', async () => {
    let called = false;
    const fetchImpl = async (input: RequestInfo | URL) => {
      called = true;
      return new Response(JSON.stringify({ items: [String(input)] }), { status: 200 });
    };
    const result = await searchModule.fetchSongsByIds('https://api.example.test', [], fetchImpl);
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = async () => new Response('nope', { status: 400 });
    await expect(
      searchModule.fetchSongsByIds('https://api.example.test', ['a'], fetchImpl),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('throws when the response is missing an items array', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ nope: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(
      searchModule.fetchSongsByIds('https://api.example.test', ['a'], fetchImpl),
    ).rejects.toThrow(/missing items array/);
  });

  it('batches >100 ids into multiple requests of <=100 and concatenates results', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const batches: string[][] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const idsParam = url.searchParams.get('ids') ?? '';
      const batch = idsParam.split(',');
      batches.push(batch);
      // Echo one record per id so we can assert the concat behavior + count.
      const items = batch.map((id) => ({ id }) as unknown as SongRecord);
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await searchModule.fetchSongsByIds('https://api.example.test', ids, fetchImpl);

    // 250 ids → batches of 100, 100, 50.
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(result.length).toBe(250);
    expect(result.map((r) => r.id)).toEqual(ids);
  });
});
