import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import { enrichWithTranslit } from '../../../src/adapters/tj-media-direct/enrichTranslit.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

function rawFor(over: Partial<RawSongRecord> & { tj: string }): RawSongRecord {
  const { tj, ...rest } = over;
  return {
    source_url: 'https://example.test',
    title_primary: `title-${tj}`,
    title_ko: null,
    artist_primary: `artist-${tj}`,
    artist_ko: null,
    karaoke_numbers: { tj, ky: null, joysound: null },
    categories: ['jpop'],
    ...rest,
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

describe('enrichWithTranslit', () => {
  it('cold start (empty cache): fetches every record, populates byPro and the cache', async () => {
    const records = [
      rawFor({ tj: '111', title_primary: 'A' }),
      rawFor({ tj: '222', title_primary: 'B' }),
    ];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(({ searchTxt }) => {
      if (searchTxt === 'A') {
        return searchResp([
          {
            pro: 111,
            indexTitle: 'A',
            indexSong: 'aa',
            sortTitleKo: 'ㄱ',
            sortSongKo: 'ㄴ',
            nationalcode: 'JPN',
          },
        ]);
      }
      if (searchTxt === 'B') {
        return searchResp([
          {
            pro: 222,
            indexTitle: 'B',
            indexSong: 'bb',
            sortTitleKo: 'ㄷ',
            sortSongKo: '',
            nationalcode: 'JPN',
          },
        ]);
      }
      return searchResp([]);
    });
    const logger = silentLogger();
    const { byPro, stats } = await enrichWithTranslit(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger,
    });

    expect(calls).toHaveLength(2);
    expect(stats.fetches).toBe(2);
    expect(stats.cacheHits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.errors).toBe(0);
    expect(byPro.get('111')?.sortTitleKo).toBe('ㄱ');
    expect(byPro.get('111')?.sortSongKo).toBe('ㄴ');
    expect(byPro.get('222')?.sortTitleKo).toBe('ㄷ');
    expect(byPro.get('222')?.sortSongKo).toBeNull();
    expect(cache.proEnrichmentMap['111']?.lastSeen).toBe('2026-04-29T00:00:00.000Z');
    expect(cache.proEnrichmentMap['222']?.lastSeen).toBe('2026-04-29T00:00:00.000Z');
  });

  it('warm start: fresh cache entries are reused without HTTP calls', async () => {
    const records = [rawFor({ tj: '111', title_primary: 'A' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.proEnrichmentMap['111'] = {
      nationalcode: 'JPN',
      sortTitleKo: '캐시된',
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { client, calls } = buildHttp(() => {
      throw new Error('should not be called');
    });
    const { byPro, stats } = await enrichWithTranslit(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });

    expect(calls).toHaveLength(0);
    expect(stats.cacheHits).toBe(1);
    expect(stats.fetches).toBe(0);
    expect(byPro.get('111')?.sortTitleKo).toBe('캐시된');
  });

  it('partial cache: hits are reused, misses are fetched', async () => {
    const records = [
      rawFor({ tj: '111', title_primary: 'A' }), // cache hit
      rawFor({ tj: '222', title_primary: 'B' }), // fetch
    ];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.proEnrichmentMap['111'] = {
      nationalcode: 'JPN',
      sortTitleKo: '캐시된',
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { client, calls } = buildHttp(() =>
      searchResp([{ pro: 222, indexTitle: 'B', indexSong: 'bb', sortTitleKo: 'ㄷ' }]),
    );
    const { byPro, stats } = await enrichWithTranslit(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.searchTxt).toBe('B');
    expect(stats.cacheHits).toBe(1);
    expect(stats.fetches).toBe(1);
    expect(byPro.get('111')?.sortTitleKo).toBe('캐시된');
    expect(byPro.get('222')?.sortTitleKo).toBe('ㄷ');
  });

  it('pro mismatch (TJ search returned a different song): record falls back to null translit, counts as miss', async () => {
    const records = [rawFor({ tj: '111', title_primary: 'A' })];
    const cache = emptyCache();
    const { client } = buildHttp(() =>
      // Search returned a different `pro` — title was a coincidence.
      searchResp([{ pro: 999, indexTitle: 'A', indexSong: 'X', sortTitleKo: 'wrong' }]),
    );
    const { byPro, stats } = await enrichWithTranslit(client, records, cache, {
      logger: silentLogger(),
    });

    expect(byPro.has('111')).toBe(false);
    expect(stats.fetches).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it('HTTP error on a fetch is logged and the pipeline continues', async () => {
    const records = [
      rawFor({ tj: '111', title_primary: 'A' }), // throws
      rawFor({ tj: '222', title_primary: 'B' }), // succeeds
    ];
    const cache = emptyCache();
    const { client } = buildHttp(({ searchTxt }) => {
      if (searchTxt === 'A') {
        return { status: 503, body: 'oops' };
      }
      return searchResp([{ pro: 222, indexTitle: 'B', indexSong: 'b', sortTitleKo: 'ㄷ' }]);
    });
    const logger = silentLogger();
    const { byPro, stats } = await enrichWithTranslit(client, records, cache, { logger });

    expect(byPro.has('111')).toBe(false);
    expect(byPro.get('222')?.sortTitleKo).toBe('ㄷ');
    expect(stats.errors).toBe(1);
    expect(stats.fetches).toBe(1);
    expect(logger.warns.some((w) => /pro=111/.test(w))).toBe(true);
  });

  it('fetch error after a prior miss does NOT double-count as a miss (regression)', async () => {
    // Record 0 fetches successfully but the result has no matching `pro` (miss).
    // Record 1 throws (HTTP 503 -> error). Pre-fix, the cache-miss branch
    // unconditionally checked `if (stats.fetches > 0) stats.misses++` for the
    // undefined-match case — so record 1 (which never set `match`) would bump
    // misses too, double-counting transport errors as misses.
    const records = [
      rawFor({ tj: '111', title_primary: 'A' }), // fetch succeeds, pro mismatch -> miss
      rawFor({ tj: '222', title_primary: 'B' }), // fetch throws -> error
    ];
    const cache = emptyCache();
    const { client } = buildHttp(({ searchTxt }) => {
      if (searchTxt === 'A') {
        // Successful fetch but `pro` mismatch -> bona fide miss.
        return searchResp([{ pro: 999, indexTitle: 'A', indexSong: 'X', sortTitleKo: 'wrong' }]);
      }
      return { status: 503, body: 'oops' };
    });
    const { byPro, stats } = await enrichWithTranslit(client, records, cache, {
      logger: silentLogger(),
    });

    expect(byPro.has('111')).toBe(false);
    expect(byPro.has('222')).toBe(false);
    expect(stats.fetches).toBe(1); // record 0 only
    expect(stats.misses).toBe(1); // record 0 only — NOT record 1
    expect(stats.errors).toBe(1); // record 1 only
  });

  it('skips records with null tj', async () => {
    const baseRecord = rawFor({ tj: '111', title_primary: 'A' });
    const noTj: RawSongRecord = {
      ...baseRecord,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
    };
    const all = [noTj, baseRecord];
    const cache = emptyCache();
    const { client, calls } = buildHttp(() =>
      searchResp([{ pro: 111, indexTitle: 'A', indexSong: 'a', sortTitleKo: 'k' }]),
    );
    await enrichWithTranslit(client, all, cache, { logger: silentLogger() });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.searchTxt).toBe('A');
  });

  it('logs progress every progressEveryN records', async () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      rawFor({ tj: String(i), title_primary: String(i) }),
    );
    const cache = emptyCache();
    // Fresh entries so we don't actually fetch.
    for (const r of records) {
      cache.proEnrichmentMap[r.karaoke_numbers.tj as string] = {
        nationalcode: 'JPN',
        sortTitleKo: 'k',
        sortSongKo: null,
        subTitle: null,
        publishdate: null,
        lastSeen: new Date().toISOString(),
      };
    }
    const { client } = buildHttp(() => {
      throw new Error('unreachable');
    });
    const logs: string[] = [];
    await enrichWithTranslit(client, records, cache, {
      progressEveryN: 2,
      logger: { log: (m) => logs.push(m), warn: () => {} },
    });
    // 5 records / N=2 -> progress at i=1 and i=3 (zero-indexed) plus the final summary.
    const progressLines = logs.filter((l) => /enriched \d+\/5/.test(l));
    expect(progressLines.length).toBeGreaterThanOrEqual(2);
  });
});
