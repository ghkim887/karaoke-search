import { describe, expect, it } from 'vitest';
import {
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

describe('bootstrapArtistMapFromCharts', () => {
  it('issues 2 calls per week (TOP + HOT) for the configured sweep window', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client, calls } = buildHttp(() => chartResp([]));
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 3,
    });
    // 3 weeks × 2 chartTypes = 6 calls.
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.url.includes('topAndHot100'))).toBe(true);
    expect(calls.every((c) => c.body.strType === '3')).toBe(true);
  });

  it('dedupes by `pro` across weeks (one charting song = one vote)', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    // The same single item charts in every weekly window — that should
    // count as ONE distinct `pro`, NOT N votes. Single-pro = no confident
    // tag (threshold is ≥3 distinct pros).
    const { client } = buildHttp(() =>
      chartResp([{ pro: 68058, indexTitle: 'Pretender', indexSong: 'Official髭男dism' }]),
    );
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 5,
    });
    // 5 weeks × 2 charts × 1 item = 10 returns, all the SAME pro. Distinct
    // pros = 1; below the ≥3 threshold; nothing tagged.
    const key = 'official髭男dism';
    expect(cache.artistNationalityMap[key]).toBeUndefined();
  });

  it('tags an artist confidently JPN when ≥3 distinct pros chart', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    let weekCounter = 0;
    const { client } = buildHttp(() => {
      weekCounter++;
      // Different pro per call so distinct count grows.
      return chartResp([{ pro: 60000 + weekCounter, indexTitle: 'song', indexSong: 'YOASOBI' }]);
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

  it('does NOT downgrade a mixed-vote (searchSong-derived) entry', async () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.artistNationalityMap.ambiguousact = {
      code: 'AMBIGUOUS',
      votes: { JPN: 2, KOR: 3, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    let counter = 0;
    const { client } = buildHttp(() => {
      counter++;
      return chartResp([{ pro: 60000 + counter, indexTitle: 't', indexSong: 'AmbiguousAct' }]);
    });
    await bootstrapArtistMapFromCharts(client, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
      sweepWeeks: 5,
    });
    // Existing AMBIGUOUS entry has KOR > 0, so chart evidence is rejected.
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
    expect(stats.callsOk).toBe(1);
    expect(logger.warns.some((w) => /chart fetch failed/.test(w))).toBe(true);
  });
});
