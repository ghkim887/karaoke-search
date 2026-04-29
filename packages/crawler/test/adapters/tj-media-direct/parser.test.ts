import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import { parseCatalogResponse, shouldKeep } from '../../../src/adapters/tj-media-direct/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/catalog-sample.json');
const SOURCE_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * Helper: build a freshly-tagged JPN cache entry for an artist.
 */
function jpnArtist(): {
  code: 'JPN';
  votes: { JPN: number; KOR: number; ENG: number };
  lastSeen: string;
} {
  return { code: 'JPN', votes: { JPN: 1, KOR: 0, ENG: 0 }, lastSeen: '2026-04-29T00:00:00.000Z' };
}

describe('parseCatalogResponse — empty cache + empty whitelist (everything drops)', () => {
  it('drops every record when no path can confirm JPN', () => {
    const { records, stats } = parseCatalogResponse(FIXTURE, SOURCE_URL, { cache: emptyCache() });
    expect(records).toEqual([]);
    expect(stats.admittedByArtist).toBe(0);
    expect(stats.admittedByPro).toBe(0);
    expect(stats.admittedByRescue).toBe(0);
    expect(stats.dropped).toBeGreaterThan(0);
  });
});

describe('parseCatalogResponse — per-record nationalcode confirmation (path 1)', () => {
  it('keeps a record when its pro is JPN-tagged in proEnrichmentMap', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['68781'] = {
      nationalcode: 'JPN',
      sortTitleKo: '아이도루',
      sortSongKo: null,
      subTitle: null,
      publishdate: '2023-05-24',
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records } = parseCatalogResponse(FIXTURE, SOURCE_URL, { cache });
    const idol = records.find((r) => r.karaoke_numbers.tj === '68781');
    expect(idol).toBeDefined();
    expect(idol?.title_primary).toBe('アイドル(推しの子 OP)');
    expect(idol?.artist_primary).toBe('YOASOBI');
    expect(idol?.title_ko).toBeNull();
    expect(idol?.artist_ko).toBeNull();
    expect(idol?.categories).toEqual(['jpop']);
  });

  it('drops a record when its pro is KOR-tagged (only JPN passes)', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['68781'] = {
      nationalcode: 'KOR',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records } = parseCatalogResponse(FIXTURE, SOURCE_URL, { cache });
    expect(records.find((r) => r.karaoke_numbers.tj === '68781')).toBeUndefined();
  });
});

describe('parseCatalogResponse — per-artist nationality confirmation (path 2)', () => {
  it('keeps records whose normalized artist is JPN-tagged in artistNationalityMap', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const { records } = parseCatalogResponse(FIXTURE, SOURCE_URL, { cache });
    const idol = records.find((r) => r.karaoke_numbers.tj === '68781');
    expect(idol).toBeDefined();
    expect(idol?.artist_primary).toBe('YOASOBI');
  });

  it('drops records whose artist is KOR-tagged', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = {
      code: 'KOR',
      votes: { JPN: 0, KOR: 3, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records } = parseCatalogResponse(FIXTURE, SOURCE_URL, { cache });
    expect(records.find((r) => r.karaoke_numbers.tj === '68781')).toBeUndefined();
  });

  it('drops records whose artist is AMBIGUOUS-tagged (only JPN passes)', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = {
      code: 'AMBIGUOUS',
      votes: { JPN: 1, KOR: 1, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records } = parseCatalogResponse(FIXTURE, SOURCE_URL, { cache });
    expect(records.find((r) => r.karaoke_numbers.tj === '68781')).toBeUndefined();
  });

  it('matches normalized artist (whitespace-collapse + lowercase + NFKC)', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 3,
        items: [
          { pro: 1, indexTitle: 't1', indexSong: 'YOASOBI', publishdate: '2020-01-01' },
          { pro: 2, indexTitle: 't2', indexSong: 'yoasobi', publishdate: '2020-01-01' },
          { pro: 3, indexTitle: 't3', indexSong: 'Yo asobi', publishdate: '2020-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const { records } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(3);
  });
});

describe('parseCatalogResponse — blog-whitelist rescue (path 3)', () => {
  it('rescues an all-Latin Japanese act when forceIncludeTjNumbers contains its pro', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 1,
        items: [
          {
            pro: 12345,
            indexTitle: 'Trash Candy',
            indexSong: 'GRANRODEO',
            publishdate: '2016-01-27',
          },
        ],
      },
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, {
      cache: emptyCache(),
      forceIncludeTjNumbers: new Set(['12345']),
    });
    expect(records.length).toBe(1);
    expect(records[0]?.artist_primary).toBe('GRANRODEO');
    expect(records[0]?.karaoke_numbers.tj).toBe('12345');
    expect(stats.admittedByRescue).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
    expect(stats.admittedByPro).toBe(0);
  });

  it('drops the same record when its pro is NOT in the whitelist and cache is empty', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 1,
        items: [
          {
            pro: 12345,
            indexTitle: 'Trash Candy',
            indexSong: 'GRANRODEO',
            publishdate: '2016-01-27',
          },
        ],
      },
    };
    const { records } = parseCatalogResponse(json, SOURCE_URL, {
      cache: emptyCache(),
      forceIncludeTjNumbers: new Set<string>(),
    });
    expect(records).toEqual([]);
  });

  it('rescue still requires non-empty pro / indexTitle / indexSong', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 2,
        items: [
          { pro: 1, indexTitle: '', indexSong: 'GRANRODEO', publishdate: '2020-01-01' },
          { pro: 2, indexTitle: 'Trash Candy', indexSong: '', publishdate: '2020-01-01' },
        ],
      },
    };
    const { records } = parseCatalogResponse(json, SOURCE_URL, {
      cache: emptyCache(),
      forceIncludeTjNumbers: new Set(['1', '2']),
    });
    expect(records).toEqual([]);
  });
});

describe('parseCatalogResponse — false-negative recovery (PR-2 promise)', () => {
  it('keeps a Latin-only-titled Japanese act via per-artist tagging when blog whitelist is empty', () => {
    // PR-2 promise: a Latin-titled Japanese act not in the blog corpus must
    // still survive the filter when the per-artist scan has tagged the
    // artist as JPN. Pre-PR-2 this was a silent drop (regex matched nothing,
    // denylist didn't fire, blog rescue empty -> dropped).
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 1,
        items: [
          {
            pro: 12345,
            indexTitle: 'Trash Candy',
            indexSong: 'GRANRODEO',
            publishdate: '2016-01-27',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.granrodeo = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, {
      cache,
      forceIncludeTjNumbers: new Set<string>(),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.artist_primary).toBe('GRANRODEO');
    // Path-2 (per-artist) admitted, NOT path-3 — confirms reading order.
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.admittedByRescue).toBe(0);
  });
});

describe('parseCatalogResponse — direct unit cases', () => {
  it('returns an empty array when items is empty', () => {
    const empty = {
      resultCode: '00',
      resultData: { itemsTotalCount: 0, items: [] },
      resultMsg: 'ok',
    };
    expect(parseCatalogResponse(empty, SOURCE_URL, { cache: emptyCache() }).records).toEqual([]);
  });

  it('skips items with missing/empty pro, indexTitle, or indexSong', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 4,
        items: [
          { pro: 1, indexTitle: 'アイドル', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          { pro: null, indexTitle: 'アイドル2', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          { pro: 2, indexTitle: '', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          { pro: 3, indexTitle: 'アイドル3', indexSong: '', publishdate: '2023-05-24' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const { records } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records.length).toBe(1);
    expect(records[0]?.karaoke_numbers.tj).toBe('1');
  });

  it('throws when response is not an object', () => {
    expect(() => parseCatalogResponse(null, SOURCE_URL, { cache: emptyCache() })).toThrow(
      /not a JSON object/,
    );
    expect(() => parseCatalogResponse('a string', SOURCE_URL, { cache: emptyCache() })).toThrow(
      /not a JSON object/,
    );
    expect(() => parseCatalogResponse(42, SOURCE_URL, { cache: emptyCache() })).toThrow(
      /not a JSON object/,
    );
  });

  it('throws when resultData is missing or wrong shape', () => {
    expect(() => parseCatalogResponse({}, SOURCE_URL, { cache: emptyCache() })).toThrow(
      /resultData/,
    );
    expect(() =>
      parseCatalogResponse({ resultData: 'oops' }, SOURCE_URL, { cache: emptyCache() }),
    ).toThrow(/resultData/);
  });

  it('throws when items is not an array', () => {
    expect(() =>
      parseCatalogResponse({ resultData: { items: 'not an array' } }, SOURCE_URL, {
        cache: emptyCache(),
      }),
    ).toThrow(/items is not an array/);
    expect(() =>
      parseCatalogResponse({ resultData: { items: null } }, SOURCE_URL, { cache: emptyCache() }),
    ).toThrow(/items is not an array/);
  });

  it('every kept record has Korean fields null and categories=["jpop"]', () => {
    const cache = emptyCache();
    // Tag every artist in the fixture so the filter passes everything.
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const fixture = {
      resultCode: '99',
      resultData: {
        itemsTotalCount: 1,
        items: [
          { pro: 99, indexTitle: 'アイドル', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
        ],
      },
    };
    const { records } = parseCatalogResponse(fixture, SOURCE_URL, { cache });
    expect(records).toHaveLength(1);
    expect(records[0]?.title_ko).toBeNull();
    expect(records[0]?.artist_ko).toBeNull();
    expect(records[0]?.categories).toEqual(['jpop']);
    expect(records[0]?.karaoke_numbers.ky).toBeNull();
    expect(records[0]?.karaoke_numbers.joysound).toBeNull();
  });
});

describe('shouldKeep — direct unit', () => {
  it('returns true on path-1 hit (per-record JPN)', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['1'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    expect(shouldKeep('1', 'whatever', cache)).toBe(true);
  });

  it('returns true on path-2 hit (per-artist JPN) even without path-1 entry', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    expect(shouldKeep('1', 'YOASOBI', cache)).toBe(true);
  });

  it('returns true on path-3 hit (whitelist) even without path-1/2', () => {
    const cache = emptyCache();
    expect(shouldKeep('1', 'whatever', cache, new Set(['1']))).toBe(true);
  });

  it('returns false when all three paths miss', () => {
    expect(shouldKeep('1', 'whatever', emptyCache())).toBe(false);
  });
});

describe('parseCatalogResponse — KeepStats per-path admit counters', () => {
  /**
   * Reading order: per-artist (1) → per-record (2) → blog whitelist (3).
   * "First to fire wins" — these tests verify that ordering shows up in the
   * counters, not that "any-admit" semantics changed.
   */
  it('counts each kept record under exactly one path (first-to-fire)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          // by-artist only:
          { pro: 1, indexTitle: 't1', indexSong: 'YOASOBI', publishdate: '2020-01-01' },
          // by-pro only (artist not tagged):
          { pro: 2, indexTitle: 't2', indexSong: 'UnknownActA', publishdate: '2020-01-01' },
          // by-rescue only (no artist or pro tags):
          { pro: 3, indexTitle: 't3', indexSong: 'UnknownActB', publishdate: '2020-01-01' },
          // dropped (no path):
          { pro: 4, indexTitle: 't4', indexSong: 'UnknownActC', publishdate: '2020-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    cache.proEnrichmentMap['2'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, {
      cache,
      forceIncludeTjNumbers: new Set(['3']),
    });
    expect(records).toHaveLength(3);
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.admittedByPro).toBe(1);
    expect(stats.admittedByRescue).toBe(1);
    expect(stats.dropped).toBe(1);
  });

  it('per-artist beats per-record when both tags say JPN (reading-order check)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 99, indexTitle: 't', indexSong: 'YOASOBI', publishdate: '2020-01-01' }],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    cache.proEnrichmentMap['99'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.admittedByPro).toBe(0);
  });

  it('per-record beats blog rescue when both would admit (reading-order check)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 99, indexTitle: 't', indexSong: 'UnknownAct', publishdate: '2020-01-01' }],
      },
    };
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { stats } = parseCatalogResponse(json, SOURCE_URL, {
      cache,
      forceIncludeTjNumbers: new Set(['99']),
    });
    expect(stats.admittedByPro).toBe(1);
    expect(stats.admittedByRescue).toBe(0);
  });
});
