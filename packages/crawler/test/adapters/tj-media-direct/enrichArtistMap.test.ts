import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import { enrichArtistMap } from '../../../src/adapters/tj-media-direct/enrichArtistMap.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

function rawFor(over: Partial<RawSongRecord> & { tj: string; artist: string }): RawSongRecord {
  const { tj, artist, ...rest } = over;
  return {
    source_url: 'https://example.test',
    title_primary: `title-${tj}`,
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj, ky: null, joysound: null },
    categories: ['jpop'],
    ...rest,
  };
}

interface CapturedCall {
  url: string;
  body: Record<string, string>;
}

function buildHttp(handler: (body: Record<string, string>) => FetchResult | null): {
  client: Pick<HttpClient, 'postForm'>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  return {
    calls,
    client: {
      async postForm(url, body): Promise<FetchResult | null> {
        calls.push({ url, body: { ...body } });
        return handler(body);
      },
    },
  };
}

function searchResp(items: Array<Record<string, unknown>>): FetchResult {
  return {
    status: 200,
    body: JSON.stringify({
      resultCode: '99',
      resultMsg: '성공',
      resultData: { itemsTotalCount: items.length, items },
    }),
  };
}

function silentLogger(): { log(msg: string): void; warn(msg: string): void; warns: string[] } {
  const warns: string[] = [];
  return {
    log: () => {},
    warn: (m) => warns.push(m),
    warns,
  };
}

describe('enrichArtistMap', () => {
  it('classifies an all-JPN-vote artist as JPN', async () => {
    const records = [rawFor({ tj: '1', artist: 'YOASOBI' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(({ searchTxt }) => {
      if (searchTxt === 'YOASOBI') {
        return searchResp([
          { pro: 1, indexTitle: 't1', indexSong: 'YOASOBI', nationalcode: 'JPN' },
          { pro: 2, indexTitle: 't2', indexSong: 'YOASOBI', nationalcode: 'JPN' },
          { pro: 3, indexTitle: 't3', indexSong: 'YOASOBI', nationalcode: 'JPN' },
        ]);
      }
      return searchResp([]);
    });
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    const entry = cache.artistNationalityMap.yoasobi;
    expect(entry?.code).toBe('JPN');
    expect(entry?.votes.JPN).toBe(3);
  });

  it('classifies an all-KOR-vote artist as KOR', async () => {
    const records = [rawFor({ tj: '1', artist: 'BTS' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 1, indexTitle: 't1', indexSong: 'BTS', nationalcode: 'KOR' },
        { pro: 2, indexTitle: 't2', indexSong: 'BTS', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.artistNationalityMap.bts?.code).toBe('KOR');
  });

  it('classifies a mixed-vote artist as AMBIGUOUS', async () => {
    const records = [rawFor({ tj: '1', artist: 'AmbiguousAct' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 1, indexTitle: 't1', indexSong: 'AmbiguousAct', nationalcode: 'JPN' },
        { pro: 2, indexTitle: 't2', indexSong: 'AmbiguousAct', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    const entry = cache.artistNationalityMap.ambiguousact;
    expect(entry?.code).toBe('AMBIGUOUS');
    expect(entry?.votes.JPN).toBe(1);
    expect(entry?.votes.KOR).toBe(1);
  });

  it('classifies an artist with zero exact-match votes as UNKNOWN', async () => {
    const records = [rawFor({ tj: '1', artist: 'ObscureAct' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      // Search returned songs by some OTHER artist — none of them exact-match.
      searchResp([{ pro: 1, indexTitle: 't1', indexSong: 'AnotherAct', nationalcode: 'JPN' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.artistNationalityMap.obscureact?.code).toBe('UNKNOWN');
  });

  it('uses normalized matching (case + whitespace + NFKC)', async () => {
    const records = [rawFor({ tj: '1', artist: 'YOASOBI' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      // TJ returned a different case + extra whitespace — must still
      // exact-match after normalize.
      searchResp([{ pro: 1, indexTitle: 't1', indexSong: 'yo  asobi', nationalcode: 'JPN' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.artistNationalityMap.yoasobi?.code).toBe('JPN');
  });

  it('cache hit short-circuits HTTP', async () => {
    const records = [rawFor({ tj: '1', artist: 'YOASOBI' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.artistNationalityMap.yoasobi = {
      code: 'JPN',
      votes: { JPN: 5, KOR: 0, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { client, calls } = buildHttp(() => {
      throw new Error('should not be called');
    });
    const stats = await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(calls).toHaveLength(0);
    expect(stats.cacheHits).toBe(1);
    expect(stats.fetches).toBe(0);
  });

  it('dedupes artists across multiple records (one HTTP call per distinct artist)', async () => {
    const records = [
      rawFor({ tj: '1', artist: 'YOASOBI' }),
      rawFor({ tj: '2', artist: 'YOASOBI' }),
      rawFor({ tj: '3', artist: 'YOASOBI' }),
    ];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(() =>
      searchResp([{ pro: 1, indexTitle: 't', indexSong: 'YOASOBI', nationalcode: 'JPN' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
  });

  it('HTTP error leaves the cache untouched (so a future crawl retries)', async () => {
    const records = [rawFor({ tj: '1', artist: 'FlakeyArtist' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() => ({ status: 503, body: 'oops' }));
    const logger = silentLogger();
    const stats = await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger,
    });
    expect(cache.artistNationalityMap.flakeyartist).toBeUndefined();
    expect(stats.errors).toBe(1);
    expect(logger.warns.some((w) => /FlakeyArtist/.test(w))).toBe(true);
  });

  it('PR-4: scans every component of a collab string + the whole string', async () => {
    // Catalog has 2 records:
    //   - whole-string scan (`imase`)
    //   - collab string (`imase & なとり`) which must split into both
    //     components AND the whole string.
    //
    // After the scan, ALL of `imase`, `なとり`, AND the whole `imase & なとり`
    // key should be present in artistNationalityMap. `imase` already had its
    // own row, so the splitter MUST NOT double-fetch it.
    const records = [
      rawFor({ tj: '1', artist: 'imase' }),
      rawFor({ tj: '2', artist: 'imase & なとり' }),
    ];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(({ searchTxt }) => {
      // TJ returns each artist as JPN when searched directly, and returns
      // empty for the combined `imase & なとり` (which is how the live
      // searchSong index typically behaves for collab strings).
      if (searchTxt === 'imase') {
        return searchResp([{ pro: 1, indexTitle: 't', indexSong: 'imase', nationalcode: 'JPN' }]);
      }
      if (searchTxt === 'なとり') {
        return searchResp([{ pro: 2, indexTitle: 't', indexSong: 'なとり', nationalcode: 'JPN' }]);
      }
      // The combined string scan finds nothing exact-matching itself — the
      // entry is still recorded, just as UNKNOWN.
      return searchResp([]);
    });
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });

    // Both component artists got their own JPN entry.
    expect(cache.artistNationalityMap.imase?.code).toBe('JPN');
    expect(cache.artistNationalityMap.なとり?.code).toBe('JPN');
    // The combined string is in the cache too — UNKNOWN because TJ search
    // returned no exact-match results for the literal `imase & なとり` query.
    const wholeKey = 'imase&なとり'; // normalizeForMatch strips spaces, lowercases.
    expect(cache.artistNationalityMap[wholeKey]?.code).toBe('UNKNOWN');

    // Three distinct components scanned — exactly 3 HTTP calls (no double-fetch
    // of `imase` even though both records reference it).
    expect(calls).toHaveLength(3);
    const queried = new Set(calls.map((c) => c.body.searchTxt));
    expect(queried).toEqual(new Set(['imase', 'なとり', 'imase & なとり']));
  });

  it('PR-4: dedupes components across collab strings (one fetch per distinct component)', async () => {
    // `imase` appears as both a standalone artist and as a component of two
    // different collabs — the scanner should fetch it exactly ONCE.
    const records = [
      rawFor({ tj: '1', artist: 'imase' }),
      rawFor({ tj: '2', artist: 'imase & なとり' }),
      rawFor({ tj: '3', artist: 'imase, ヨルシカ' }),
    ];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(() =>
      searchResp([{ pro: 1, indexTitle: 't', indexSong: 'imase', nationalcode: 'JPN' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });

    // `imase` count across all calls: exactly 1.
    const imaseCalls = calls.filter((c) => c.body.searchTxt === 'imase');
    expect(imaseCalls).toHaveLength(1);
  });

  it('skips records with empty artist names', async () => {
    const baseRecord = rawFor({ tj: '1', artist: 'YOASOBI' });
    const blank: RawSongRecord = { ...baseRecord, artist_primary: '' };
    const records = [blank, baseRecord];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(() =>
      searchResp([{ pro: 1, indexTitle: 't', indexSong: 'YOASOBI', nationalcode: 'JPN' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
  });
});
