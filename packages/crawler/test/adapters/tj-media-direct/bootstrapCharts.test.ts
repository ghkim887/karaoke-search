import { describe, expect, it } from 'vitest';
import {
  CHART_GENRES,
  bootstrapArtistMapFromCharts,
  parseChartResponse,
  weekWindow,
} from '../../../src/adapters/tj-media-direct/bootstrapCharts.js';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

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

function chartResp(items: Array<Record<string, unknown>>): FetchResult {
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

describe('weekWindow', () => {
  it('returns a 7-day inclusive window ending at `now` for week 0', () => {
    const now = new Date('2026-04-29T00:00:00.000Z');
    const { start, end } = weekWindow(now, 0);
    expect(end).toBe('2026-04-29');
    expect(start).toBe('2026-04-23'); // 6 days earlier
  });

  it('shifts back 7 days per week index', () => {
    const now = new Date('2026-04-29T00:00:00.000Z');
    const w1 = weekWindow(now, 1);
    const w2 = weekWindow(now, 2);
    expect(w1.end).toBe('2026-04-22');
    expect(w1.start).toBe('2026-04-16');
    expect(w2.end).toBe('2026-04-15');
    expect(w2.start).toBe('2026-04-09');
  });
});

describe('parseChartResponse', () => {
  it('parses the flat chart response shape', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 1, indexTitle: 'Pretender', indexSong: 'Official髭男dism' },
          { pro: 2, indexTitle: 'アイドル', indexSong: 'YOASOBI' },
        ],
      },
    };
    const items = parseChartResponse(json);
    expect(items).toHaveLength(2);
    expect(items[0]?.pro).toBe('1');
    expect(items[0]?.indexSong).toBe('Official髭男dism');
  });

  it('returns [] on resultCode=98 (empty/no-data)', () => {
    expect(parseChartResponse({ resultCode: '98', resultData: '' })).toEqual([]);
  });

  it('throws on resultCode 20 with the resultMsg', () => {
    expect(() => parseChartResponse({ resultCode: '20', resultMsg: 'missing param' })).toThrow(
      /resultCode=20/,
    );
  });

  it('skips items missing required identifiers', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 1, indexTitle: 't', indexSong: 'a' },
          { pro: null, indexTitle: 't', indexSong: 'a' },
          { pro: 2, indexTitle: '', indexSong: 'a' },
          { pro: 3, indexTitle: 't', indexSong: '' },
        ],
      },
    };
    const items = parseChartResponse(json);
    expect(items).toHaveLength(1);
    expect(items[0]?.pro).toBe('1');
  });
});

describe('CHART_GENRES — Phase 1 §2.F multi-genre sweep config', () => {
  it('exposes both JPOP (strType=3) and KPOP (strType=1) genres', () => {
    expect(CHART_GENRES).toHaveLength(2);
    const jpop = CHART_GENRES.find((g) => g.voteAs === 'JPN');
    const kpop = CHART_GENRES.find((g) => g.voteAs === 'KOR');
    expect(jpop?.strType).toBe('3');
    expect(kpop?.strType).toBe('1');
  });
});

describe('bootstrapArtistMapFromCharts', () => {
  it('issues 4 calls per week (TOP + HOT × 2 genres) for the configured sweep window', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(() => chartResp([]));
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 3,
    });
    // 3 weeks × 2 chartTypes × 2 genres = 12 calls. Plus the KOR fallback
    // (because primary KPOP sweep tagged 0 KOR artists with empty data) ran
    // an additional N searchSong calls. Filter to the chart endpoint only.
    const chartCalls = calls.filter((c) => c.url.includes('topAndHot100'));
    expect(chartCalls).toHaveLength(12);
    expect(new Set(chartCalls.map((c) => c.body.strType))).toEqual(new Set(['3', '1']));
  });

  it('dedupes by `pro` across weeks (one charting song = one vote)', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    // The same single item charts in every weekly window — that should
    // count as ONE distinct `pro`, NOT N votes. Single-pro = no confident
    // tag (threshold is ≥3 distinct pros).
    const { client } = buildHttp(({ strType }) => {
      // Only return data on the JPOP genre (strType=3); KPOP returns empty.
      if (strType === '3') {
        return chartResp([{ pro: 68058, indexTitle: 'Pretender', indexSong: 'Official髭男dism' }]);
      }
      return chartResp([]);
    });
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 5,
    });
    // 5 weeks × 2 charts × 1 item = 10 returns from JPOP, all SAME pro.
    // Distinct pros = 1; below the ≥3 threshold; nothing tagged.
    const key = 'official髭男dism';
    expect(cache.artistNationalityMap[key]).toBeUndefined();
  });

  it('tags an artist confidently JPN when ≥3 distinct pros chart on the JPOP sweep', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    let counter = 0;
    const { client } = buildHttp(({ strType }) => {
      if (strType === '3') {
        counter++;
        // Different pro per call so distinct count grows.
        return chartResp([{ pro: 60000 + counter, indexTitle: 'song', indexSong: 'YOASOBI' }]);
      }
      return chartResp([]);
    });
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 4,
    });
    const entry = cache.artistNationalityMap.yoasobi;
    expect(entry).toBeDefined();
    expect(entry?.code).toBe('JPN');
    expect(entry?.votes.JPN).toBeGreaterThanOrEqual(3);
  });

  it('tags an artist confidently KOR when ≥3 distinct pros chart on the KPOP sweep (Phase 1 §2.F)', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    let counter = 0;
    const { client } = buildHttp(({ strType }) => {
      if (strType === '1') {
        counter++;
        return chartResp([{ pro: 70000 + counter, indexTitle: 'song', indexSong: 'BTS' }]);
      }
      return chartResp([]);
    });
    const stats = await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 4,
    });
    const entry = cache.artistNationalityMap.bts;
    expect(entry).toBeDefined();
    expect(entry?.code).toBe('KOR');
    expect(entry?.votes.KOR).toBeGreaterThanOrEqual(3);
    expect(stats.artistsTaggedKor).toBeGreaterThanOrEqual(1);
    expect(stats.kpopFallbackUsed).toBe(false);
  });

  it('mixed JPN/KOR sweep populates BOTH vote slots for distinct artists', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    let jpnCounter = 0;
    let korCounter = 0;
    const { client } = buildHttp(({ strType }) => {
      if (strType === '3') {
        jpnCounter++;
        return chartResp([{ pro: 60000 + jpnCounter, indexTitle: 't', indexSong: 'YOASOBI' }]);
      }
      if (strType === '1') {
        korCounter++;
        return chartResp([{ pro: 70000 + korCounter, indexTitle: 't', indexSong: 'BTS' }]);
      }
      return chartResp([]);
    });
    const stats = await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 4,
    });
    expect(cache.artistNationalityMap.yoasobi?.code).toBe('JPN');
    expect(cache.artistNationalityMap.bts?.code).toBe('KOR');
    expect(stats.artistsTaggedJpn).toBeGreaterThanOrEqual(1);
    expect(stats.artistsTaggedKor).toBeGreaterThanOrEqual(1);
  });

  it('idempotency: existing JPN entry is NOT downgraded by a KPOP-only sweep', async () => {
    // Phase 1 §2.F idempotency requirement. If a JPOP-chart-confirmed
    // YOASOBI somehow shows up on the K-pop chart, the KPOP sweep must NOT
    // flip it to KOR.
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.artistNationalityMap.yoasobi = {
      code: 'JPN',
      votes: { JPN: 5, KOR: 0, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    let counter = 0;
    const { client } = buildHttp(({ strType }) => {
      if (strType === '1') {
        counter++;
        return chartResp([{ pro: 70000 + counter, indexTitle: 't', indexSong: 'YOASOBI' }]);
      }
      return chartResp([]);
    });
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 4,
    });
    // Existing JPN entry has JPN > 0, so the KPOP sweep skipped it.
    expect(cache.artistNationalityMap.yoasobi?.code).toBe('JPN');
    expect(cache.artistNationalityMap.yoasobi?.votes.JPN).toBe(5);
    expect(cache.artistNationalityMap.yoasobi?.votes.KOR).toBe(0);
  });

  it('does NOT downgrade a mixed-vote (searchSong-derived) entry', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.artistNationalityMap.ambiguousact = {
      code: 'AMBIGUOUS',
      votes: { JPN: 2, KOR: 3, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    let counter = 0;
    const { client } = buildHttp(({ strType }) => {
      if (strType === '3') {
        counter++;
        return chartResp([{ pro: 60000 + counter, indexTitle: 't', indexSong: 'AmbiguousAct' }]);
      }
      return chartResp([]);
    });
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 5,
    });
    // Existing AMBIGUOUS entry has KOR > 0, so JPOP-chart evidence is rejected.
    expect(cache.artistNationalityMap.ambiguousact?.code).toBe('AMBIGUOUS');
  });

  it('logs and continues on per-call HTTP errors', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const logger = silentLogger();
    let callIdx = 0;
    const { client } = buildHttp(() => {
      callIdx++;
      if (callIdx === 1) return { status: 503, body: 'oops' };
      return chartResp([]);
    });
    const stats = await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger,
      sweepWeeks: 1,
    });
    expect(stats.callsFailed).toBe(1);
    // 1 sweep week × 2 chartTypes × 2 genres = 4 chart calls; only 1 failed,
    // so 3 chart calls succeeded. Plus the KOR fallback's searchSong calls
    // (which all return empty `chartResp([])` data — counted as ok).
    expect(stats.callsOk).toBeGreaterThanOrEqual(3);
    expect(logger.warns.some((w) => /chart fetch failed/.test(w))).toBe(true);
  });

  it('Phase 1 §2.F primary→fallback failover: KOR fallback runs when KPOP sweep tagged 0 confident KOR artists', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    // KPOP chart returns empty for every call — primary path tags 0 KOR
    // artists. Fallback should fire and try `searchSong?nationType=KOR` over
    // the drop-list canonical names.
    const { client, calls } = buildHttp(({ strType }) => {
      // Chart endpoints return empty.
      if (strType === '3' || strType === '1') return chartResp([]);
      // Fallback `searchSong` call — return 3 KOR matches for `방탄소년단`
      // (one of the drop-list canonicals) so the fallback tags it.
      // strType=2 is the artist-search path used by searchSongByArtist.
      return chartResp([]);
    });
    const stats = await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 1,
    });
    expect(stats.kpopFallbackUsed).toBe(true);
    // The fallback ran (its searchSong calls hit the buildHttp handler).
    const searchSongCalls = calls.filter((c) => c.url.includes('searchSong'));
    expect(searchSongCalls.length).toBeGreaterThan(0);
  });

  it('KOR fallback skips when primary KPOP sweep tagged ≥1 KOR artist', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    let counter = 0;
    const { client, calls } = buildHttp(({ strType }) => {
      if (strType === '1') {
        counter++;
        return chartResp([{ pro: 70000 + counter, indexTitle: 't', indexSong: 'BTS' }]);
      }
      return chartResp([]);
    });
    const stats = await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 4,
    });
    expect(stats.kpopFallbackUsed).toBe(false);
    // No fallback searchSong calls should have been made.
    const searchSongCalls = calls.filter((c) => c.url.includes('searchSong'));
    expect(searchSongCalls).toHaveLength(0);
  });
});
