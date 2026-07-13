import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import {
  classifyRecord,
  classifyRecordWithReason,
  parseCatalogResponse,
} from '../../../src/adapters/tj-media-direct/parser.js';

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
    expect(stats.admittedBySongOverride).toBe(0);
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

  it('does not admit generic Various Artists solely from an artist-level JPN cache hit', () => {
    const json = {
      resultCode: '99',
      resultData: {
        itemsTotalCount: 1,
        items: [
          {
            pro: 98158,
            indexTitle: '뽀로로와 노래해요(뽀로로와노래해요 OP)',
            indexSong: 'Various Artists',
            publishdate: '2026-05-01',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.variousartists = {
      code: 'JPN',
      votes: { JPN: 5, KOR: 0, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });

    expect(records).toEqual([]);
    expect(stats.admittedByArtist).toBe(0);
    expect(stats.dropped).toBe(1);
  });

  it('drops newly observed Korean TJ-direct leakers even when stale JPN-cached', () => {
    const json = {
      resultCode: '99',
      resultData: {
        itemsTotalCount: 2,
        items: [
          { pro: 43796, indexTitle: '나침반', indexSong: '한로로', publishdate: '2025-06-02' },
          {
            pro: 50556,
            indexTitle: 'GO!',
            indexSong: 'CORTIS(코르티스)',
            publishdate: '2025-09-17',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.한로로 = {
      code: 'JPN',
      votes: { JPN: 3, KOR: 0, ENG: 0 },
      lastSeen: '2026-05-30T19:25:46.432Z',
    };
    cache.artistNationalityMap.cortis = {
      code: 'JPN',
      votes: { JPN: 3, KOR: 0, ENG: 0 },
      lastSeen: '2026-06-04T00:00:00.000Z',
    };

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });

    expect(records).toEqual([]);
    expect(stats.admittedByArtist).toBe(0);
    expect(stats.dropped).toBe(2);
  });
});

describe('parseCatalogResponse — reviewed song-level overrides', () => {
  it('admits a reviewed K-pop Japanese release by TJ number without artist-wide allowing the act', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 26544, indexTitle: '明日は来るから(ワンピース 17th ED)', indexSong: '東方神起' },
          { pro: 999999, indexTitle: 'Korean catalog row', indexSong: '東方神起' },
        ],
      },
    };

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });

    expect(records.map((r) => r.karaoke_numbers.tj)).toEqual(['26544']);
    expect(stats.admittedBySongOverride).toBe(1);
    expect(stats.dropped).toBe(1);
  });

  it('drops a drop-listed act with a JPN pro tag when its TJ number is NOT reviewed-allowed', () => {
    // KPOP-leak regression: drop-list-reject must beat jpn-admit-pro. The
    // reviewed-allowed TJ number (26544) is admitted via song-override; the
    // non-allowed row (999999) carries a JPN pro tag yet must still drop
    // because 東方神起 is on the Korean drop list. Pre-fix the JPN pro tag on
    // 999999 leaked it in via the per-pro admit path.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 26544, indexTitle: '明日は来るから(ワンピース 17th ED)', indexSong: '東方神起' },
          { pro: 999999, indexTitle: 'Korean catalog row', indexSong: '東方神起' },
        ],
      },
    };
    const cache = emptyCache();
    cache.proEnrichmentMap['999999'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });

    expect(records.map((r) => r.karaoke_numbers.tj)).toEqual(['26544']);
    expect(stats.admittedBySongOverride).toBe(1);
    expect(stats.admittedByPro).toBe(0);
    expect(stats.dropped).toBe(1);
  });

  it('drops a reviewed generic false positive even if generic artist cache or rescue would otherwise admit it', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 7055, indexTitle: 'Besame Mucho', indexSong: 'Various Artists' }],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.variousartists = jpnArtist();

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, {
      cache,
      forceIncludeTjNumbers: new Set(['7055']),
    });

    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
  });

  it('admits the reviewed BOYNEXTDOOR JP release (tj 52990) via song-override while a non-reviewed BOYNEXTDOOR row drops', () => {
    // Option B (2026-07-09): `Count To Love` is BOYNEXTDOOR's genuine Japanese
    // maxi-single lead track, allowed by exact TJ number. Every other
    // BOYNEXTDOOR row still drops via the Korean drop list. reviewed-song-allow
    // (step 2) precedes drop-list-reject (step 3), so 52990 survives and 43349
    // (a Korean-catalog BOYNEXTDOOR row) drops.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 52990,
            indexTitle: 'Count To Love',
            indexSong: 'BOYNEXTDOOR',
            publishdate: '2025-08-18',
          },
          {
            pro: 43349,
            indexTitle: 'Nice Guy',
            indexSong: 'BOYNEXTDOOR',
            publishdate: '2023-05-30',
          },
        ],
      },
    };

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });

    expect(records.map((r) => r.karaoke_numbers.tj)).toEqual(['52990']);
    expect(stats.admittedBySongOverride).toBe(1);
    expect(stats.dropped).toBe(1);
  });

  it('admits the reviewed IVE JP release (tj 68976) and renders a script-clean artist (leak-gate safe)', () => {
    // The TJ catalog artist "IVE(아이브)" carries a Hangul gloss. The row is
    // admitted via reviewed-song-allow (step 2), and the per-song `render`
    // override stamps artist_primary="IVE" / artist_ko="아이브" so the admitted
    // row does NOT read as Korean-script leakage at the next crawl's
    // product-corpus gate. (BOYNEXTDOOR tj-52990 above needs no render — its TJ
    // raw was already Latin-only.)
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 68976, indexTitle: 'Will', indexSong: 'IVE(아이브)', publishdate: '2024-04-30' },
        ],
      },
    };

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });

    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers.tj).toBe('68976');
    expect(records[0]?.artist_primary).toBe('IVE');
    expect(records[0]?.artist_ko).toBe('아이브');
    expect(stats.admittedBySongOverride).toBe(1);
    // The exact invariant product-corpus-regression checks: title + rendered
    // artist has no Hangul, so the admitted JP release survives the leak gate.
    const text = `${records[0]?.title_primary} ${records[0]?.artist_primary}`;
    expect(text).not.toMatch(/[가-힣]/);
  });

  it('drops the reviewed CUTIE STREET Korean-language row (tj 70438) but keeps their Japanese row', () => {
    // Per-song drop: CUTIE STREET is a Japanese act, so its artist tag admits
    // at jpn-admit-artist (step 5) — and MUST keep doing so for their
    // Japanese-language rows. The 프리큐큐 row is the KOR-language release and
    // drops by exact TJ number at reviewed-song-drop (step 0, which runs first),
    // WITHOUT the artist going on the Korean drop list.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 70438,
            indexTitle: '프리큐큐',
            indexSong: 'CUTIE STREET',
            publishdate: '2026-06-06',
          },
          {
            pro: 70439,
            indexTitle: 'ぷりきゅきゅ',
            indexSong: 'CUTIE STREET',
            publishdate: '2024-01-01',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.cutiestreet = jpnArtist();

    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });

    expect(records.map((r) => r.karaoke_numbers.tj)).toEqual(['70439']);
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.dropped).toBe(1);
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
    expect(stats.admittedBySongOverride).toBe(0);
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

describe('parseCatalogResponse — Phase 1 §2.B lead-component-only admit', () => {
  /**
   * Phase 1 §2.B (KPOP-leak fix, 2026-05-01) tightens the per-artist admit
   * rule from "any component JPN-tagged" to "LEAD component JPN-tagged". The
   * lead is index 1 of `splitArtistCollab(...)` when ≥2 components exist (the
   * splitter places the whole string at index 0), else index 0. This drops
   * the `Charlie Puth(Feat.宇多田ヒカル)` family — Western lead, JP feature —
   * which is intentional per the spec's behavior table.
   */
  it('admits a collab when the LEAD component is JPN-tagged', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 1, indexTitle: 'glow', indexSong: 'imase & なとり', publishdate: '2024-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    // `imase` is the LEAD component (index 1 of splitArtistCollab; whole
    // string at index 0). Phase 1 §2.B admits when the lead is JPN-tagged.
    cache.artistNationalityMap.imase = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(1);
    expect(records[0]?.artist_primary).toBe('imase & なとり');
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.admittedByPro).toBe(0);
    expect(stats.admittedByRescue).toBe(0);
    expect(stats.dropped).toBe(0);
  });

  it('drops a `feat.` parenthetical collab when ONLY the featured artist is JPN-tagged (lead is non-JPN)', () => {
    // Phase 1 §2.B explicit case from the behavior table:
    //   `Charlie Puth(Feat.宇多田ヒカル)` → lead `Charlie Puth` is non-JPN
    //   in cache → DROP (was KEEP under PR-4 any-component rule).
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 2,
            indexTitle: 'Light Switch',
            indexSong: 'Charlie Puth(Feat.宇多田ヒカル)',
            publishdate: '2022-01-20',
          },
        ],
      },
    };
    const cache = emptyCache();
    // Only the featured artist is tagged JPN. Lead `Charlie Puth` has no
    // entry — falls through every admit path and drops.
    cache.artistNationalityMap.宇多田ヒカル = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(0);
    expect(stats.admittedByArtist).toBe(0);
    expect(stats.dropped).toBe(1);
  });

  it('still admits a `feat.` collab when the featured artist is JPN AND the per-record pro is JPN-tagged (path 3)', () => {
    // Path-2 (per-pro) is the safety net for the case where the lead is
    // unknown but the specific record is confidently JPN.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 99,
            indexTitle: 'Collab Track',
            indexSong: 'WesternLead(Feat.宇多田ヒカル)',
            publishdate: '2022-01-20',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.宇多田ヒカル = jpnArtist();
    cache.proEnrichmentMap['99'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(1);
    expect(stats.admittedByPro).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('regression: whole-string JPN tag still admits unchanged (no collab)', () => {
    // When the whole string itself is the JPN-tagged key (as the pre-PR-4
    // path was the only way to admit), the same record still admits via
    // path 1. The splitter's first element is the whole string, so this
    // hits on the very first lookup.
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 99, indexTitle: 'Idol', indexSong: 'YOASOBI', publishdate: '2023-05-24' }],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(1);
    expect(stats.admittedByArtist).toBe(1);
  });

  it('drops a collab when NO component is JPN-tagged', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 3,
            indexTitle: 'random',
            indexSong: 'UnknownA & UnknownB',
            publishdate: '2024-01-01',
          },
        ],
      },
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('drops a collab when a component is non-JPN (no JPN component anywhere)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 4,
            indexTitle: 'random',
            indexSong: 'KorActor & EngActor',
            publishdate: '2024-01-01',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.koractor = {
      code: 'KOR',
      votes: { JPN: 0, KOR: 3, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    cache.artistNationalityMap.engactor = {
      code: 'ENG',
      votes: { JPN: 0, KOR: 0, ENG: 3 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
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

  it('every kept record has Korean fields null and only the tj vendor number set', () => {
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
    expect(records[0]?.karaoke_numbers.ky).toBeNull();
    expect(records[0]?.karaoke_numbers.joysound).toBeNull();
  });
});

describe('classifyRecordWithReason — per-row step + reason attribution', () => {
  it('rejects a Korean drop-list act with step=drop-list-reject reason=korean-drop-list', () => {
    const d = classifyRecordWithReason('1', '', '방탄소년단', emptyCache());
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('drop-list-reject');
    expect(d.reason).toBe('korean-drop-list');
  });

  it('rejects a Chinese drop-list act with step=drop-list-reject reason=chinese-drop-list', () => {
    const d = classifyRecordWithReason('2', '', 'BEYOND', emptyCache());
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('drop-list-reject');
    expect(d.reason).toBe('chinese-drop-list');
  });

  it('rejects an explicit non-JPN pro with step=non-jpn-pro-reject reason=pro-non-jpn', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['3'] = {
      nationalcode: 'KOR',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const d = classifyRecordWithReason('3', '', 'SomeAct', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('non-jpn-pro-reject');
    expect(d.reason).toBe('pro-non-jpn');
  });

  it('rejects a reviewed song-level drop with step=reviewed-song-drop reason=reviewed-song-drop', () => {
    // tj 70438 is the reviewed-song-drop CUTIE STREET Korean-language row.
    const d = classifyRecordWithReason('70438', '', 'CUTIE STREET', emptyCache());
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('reviewed-song-drop');
    expect(d.reason).toBe('reviewed-song-drop');
  });

  it('admits via per-pro JPN tag with step=jpn-admit-pro reason=pro', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['4'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const d = classifyRecordWithReason('4', '', 'UnknownAct', cache);
    expect(d.verdict).toBe('pro');
    expect(d.step).toBe('jpn-admit-pro');
    expect(d.reason).toBe('pro');
  });

  it('admits via per-artist JPN tag with step=jpn-admit-artist reason=artist', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const d = classifyRecordWithReason('5', '', 'YOASOBI', cache);
    expect(d.verdict).toBe('artist');
    expect(d.step).toBe('jpn-admit-artist');
    expect(d.reason).toBe('artist');
  });

  it('admits via reviewed song-level allow with step=reviewed-song-allow reason=song-override', () => {
    // tj 26544 is a reviewed-song-allow K-pop Japanese release.
    const d = classifyRecordWithReason('26544', '', '東方神起', emptyCache());
    expect(d.verdict).toBe('song-override');
    expect(d.step).toBe('reviewed-song-allow');
    expect(d.reason).toBe('song-override');
  });

  it('admits via blog rescue with step=blog-rescue reason=rescue', () => {
    const d = classifyRecordWithReason('6', '', 'GRANRODEO', emptyCache(), new Set(['6']));
    expect(d.verdict).toBe('rescue');
    expect(d.step).toBe('blog-rescue');
    expect(d.reason).toBe('rescue');
  });

  it('falls through to step=null reason=no-admit-path when no step fires', () => {
    const d = classifyRecordWithReason('7', '', 'UnknownAct', emptyCache());
    expect(d.verdict).toBe('drop');
    expect(d.step).toBeNull();
    expect(d.reason).toBe('no-admit-path');
  });

  it('agrees with classifyRecord on the verdict (thin wrapper contract)', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    for (const [tj, title, artist] of [
      ['1', '', 'YOASOBI'],
      ['2', '', '방탄소년단'],
      ['3', '', 'UnknownAct'],
      // Guard path: a Hangul title over the JPN-tagged YOASOBI lead — both the
      // attribution-rich and thin classifiers must still agree on the verdict.
      ['4', '한국어제목', 'YOASOBI'],
    ] as const) {
      expect(classifyRecordWithReason(tj, title, artist, cache).verdict).toBe(
        classifyRecord(tj, title, artist, cache),
      );
    }
  });
});

describe('classifyRecordWithReason — filter-seam script guard (jpn-admit-artist)', () => {
  // The guard vetoes an artist-vote admit when the row's own text reads as
  // Korean script (Hangul present, no Japanese script over `${title} ${artist}`,
  // the #97-gate discriminator). proEnrichmentMap is EMPTY in these cases —
  // mirroring the classify-time seam where the lagging per-song KOR
  // nationalcode has not been written yet (docs/ROADMAP.md "TJ filter seam").

  it('vetoes an artist-vote admit for a Hangul-titled synthetic Korean act NOT on any drop list → drop / no-admit-path', () => {
    const cache = emptyCache();
    // Synthetic act; not on any drop list; artist scan mis-tagged it JPN.
    cache.artistNationalityMap.가상밴드 = jpnArtist();
    const d = classifyRecordWithReason('900001', '가상의 노래', '가상밴드', cache);
    expect(d.verdict).toBe('drop');
    // The guard falls through; no later step claims it, so it surfaces as the
    // no-admit-path signal (NOT an explicit deny-list reject).
    expect(d.step).toBeNull();
    expect(d.reason).toBe('no-admit-path');
  });

  it("still admits the Japanese-titled measured case (Ado「ビバリウム」) via 'artist'", () => {
    const cache = emptyCache();
    cache.artistNationalityMap.ado = jpnArtist();
    const d = classifyRecordWithReason('900002', 'ビバリウム', 'Ado', cache);
    expect(d.verdict).toBe('artist');
    expect(d.step).toBe('jpn-admit-artist');
    expect(d.reason).toBe('artist');
  });

  it('leaves a Korean-script row admitted upstream via jpn-admit-pro untouched (guard never runs)', () => {
    const cache = emptyCache();
    // Per-song JPN pro tag admits at step 4, BEFORE the guard at step 5.
    cache.proEnrichmentMap['900003'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    // Also JPN-tag the artist and give a Korean-script row text: pro still wins.
    cache.artistNationalityMap.가상밴드 = jpnArtist();
    const d = classifyRecordWithReason('900003', '한국어 제목', '가상밴드', cache);
    expect(d.verdict).toBe('pro');
    expect(d.step).toBe('jpn-admit-pro');
  });

  it('leaves a Hangul-glossed row admitted upstream via reviewed-song-allow untouched (guard never runs)', () => {
    // tj 68976 (IVE) is a reviewed-song-allow release; even with a Hangul title
    // it admits at step 2, well before the guard at step 5.
    const d = classifyRecordWithReason('68976', '한국어 제목', 'IVE(아이브)', emptyCache());
    expect(d.verdict).toBe('song-override');
    expect(d.step).toBe('reviewed-song-allow');
  });

  it('preserves the curated blog-rescue path: a Korean-script row in the force set still rescues', () => {
    // The guard vetoes the artist admit at step 5, but blog-rescue (step 6)
    // still admits a force-listed TJ number. The blog whitelist is hand-curated
    // for JP content, so this curated override is deliberately NOT overridden by
    // the guard — current semantics: admitted via 'rescue', not dropped.
    const cache = emptyCache();
    cache.artistNationalityMap.가상밴드 = jpnArtist();
    const d = classifyRecordWithReason(
      '900004',
      '가상의 노래',
      '가상밴드',
      cache,
      new Set(['900004']),
    );
    expect(d.verdict).toBe('rescue');
    expect(d.step).toBe('blog-rescue');
    expect(d.reason).toBe('rescue');
  });
});

describe('filter-seam script guard — 2026-07-09 incident rows', () => {
  // The three rows that leaked in the PR #95 weekly crawl. With their real
  // koreanArtistDropList entries PRESENT they reject at the deny-list step
  // (today's behavior, unchanged by the guard). Each Hangul-script row is then
  // shown to self-reject via the GUARD ALONE using a synthetic clone — an act
  // NOT on any drop list — proving the seam no longer depends on a
  // hand-maintained entry. BOYNEXTDOOR / "Nice Guy" is the Latin-titled
  // residual tail (no Hangul script signal) that the guard cannot see
  // (docs/ROADMAP.md "TJ filter seam"): its clone still admits, so its
  // curated drop-list entry stays load-bearing.

  it('루시 / 1년 365일 (tj-32100): real drop-list entry rejects at the deny-list step', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.루시 = jpnArtist(); // artist scan mis-tagged JPN
    const d = classifyRecordWithReason('32100', '1년 365일', '루시', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('drop-list-reject');
    expect(d.reason).toBe('korean-drop-list');
  });

  it('루시-shape synthetic clone (NOT on any drop list) self-rejects via the guard alone', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.가상루시 = jpnArtist();
    const d = classifyRecordWithReason('900101', '1년 365일', '가상루시', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBeNull();
    expect(d.reason).toBe('no-admit-path');
  });

  it('로이킴 / 봄봄봄 (tj-36707): real drop-list entry rejects at the deny-list step', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.로이킴 = jpnArtist();
    const d = classifyRecordWithReason('36707', '봄봄봄', '로이킴', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('drop-list-reject');
    expect(d.reason).toBe('korean-drop-list');
  });

  it('로이킴-shape synthetic clone (NOT on any drop list) self-rejects via the guard alone', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.가상로이 = jpnArtist();
    const d = classifyRecordWithReason('900102', '봄봄봄', '가상로이', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBeNull();
    expect(d.reason).toBe('no-admit-path');
  });

  it('BOYNEXTDOOR / Nice Guy (tj-43349): real drop-list entry rejects at the deny-list step', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.boynextdoor = jpnArtist();
    const d = classifyRecordWithReason('43349', 'Nice Guy', 'BOYNEXTDOOR', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBe('drop-list-reject');
    expect(d.reason).toBe('korean-drop-list');
  });

  it('BOYNEXTDOOR-shape synthetic clone (Latin title, NOT drop-listed) is the residual tail the guard cannot self-reject — it still admits', () => {
    // No Hangul in `${title} ${artist}` → the #97 discriminator does not fire,
    // so the guard is a no-op and the JPN artist vote admits. This is the
    // documented romaji/Latin-titled residual class; the curated drop list
    // remains the only defense for it.
    const cache = emptyCache();
    cache.artistNationalityMap.fakelatinact = jpnArtist();
    const d = classifyRecordWithReason('900103', 'Nice Guy', 'FakeLatinAct', cache);
    expect(d.verdict).toBe('artist');
    expect(d.step).toBe('jpn-admit-artist');
  });
});

describe('classifyRecordWithReason — simplified-Chinese guard (jpn-admit-artist)', () => {
  // Classify-time promotion of the report-only simplified-Chinese detector: the
  // guard vetoes an artist-vote admit when the row carries a curated PRC-only
  // simplified Han character over `${title} ${artist}`. proEnrichmentMap is EMPTY
  // in these cases — the lagging per-song nationalcode seam, exactly as for the
  // Korean-script guard (docs/ROADMAP.md "TJ filter seam").

  it('vetoes an artist-vote admit for a simplified-Chinese-titled synthetic Mandopop act NOT on any drop list → drop / no-admit-path', () => {
    const cache = emptyCache();
    // Synthetic act; not on any drop list; artist scan mis-tagged it JPN.
    cache.artistNationalityMap.星光 = jpnArtist();
    const d = classifyRecordWithReason('900201', '明天你依然爱我', '星光', cache);
    expect(d.verdict).toBe('drop');
    // The guard falls through; no later step claims it, so it surfaces as the
    // no-admit-path signal (NOT an explicit deny-list reject).
    expect(d.step).toBeNull();
    expect(d.reason).toBe('no-admit-path');
  });

  it("still admits a Japanese shinjitai-titled row via 'artist' (no false veto on 国/桜-class)", () => {
    // 国家と桜: shinjitai (国) that equals a PRC simplification but is valid
    // Japanese, plus a JP-only shinjitai (桜) — both excluded from the curated
    // set — so the guard is a no-op and the artist vote admits.
    const cache = emptyCache();
    cache.artistNationalityMap.ado = jpnArtist();
    const d = classifyRecordWithReason('900202', '国家と桜', 'Ado', cache);
    expect(d.verdict).toBe('artist');
    expect(d.step).toBe('jpn-admit-artist');
    expect(d.reason).toBe('artist');
  });

  it('leaves a simplified-Chinese row admitted upstream via jpn-admit-pro untouched (guard never runs)', () => {
    const cache = emptyCache();
    // Per-song JPN pro tag admits at step 4, BEFORE the guard at step 5.
    cache.proEnrichmentMap['900203'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    cache.artistNationalityMap.星光 = jpnArtist();
    const d = classifyRecordWithReason('900203', '明天你依然爱我', '星光', cache);
    expect(d.verdict).toBe('pro');
    expect(d.step).toBe('jpn-admit-pro');
  });

  it('leaves a reviewed-song-allow release untouched even with a simplified-Chinese title (guard never runs)', () => {
    // tj 68976 (IVE) is a reviewed-song-allow release; it admits at step 2, well
    // before the guard at step 5, regardless of the row text.
    const d = classifyRecordWithReason('68976', '明天你依然爱我', 'IVE(아이브)', emptyCache());
    expect(d.verdict).toBe('song-override');
    expect(d.step).toBe('reviewed-song-allow');
  });

  it('still vetoes a Korean-script row — both guards coexist', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.가상밴드 = jpnArtist();
    const d = classifyRecordWithReason('900205', '가상의 노래', '가상밴드', cache);
    expect(d.verdict).toBe('drop');
    expect(d.step).toBeNull();
    expect(d.reason).toBe('no-admit-path');
  });

  it('preserves the curated blog-rescue path: a simplified-Chinese row in the force set still rescues', () => {
    // The guard vetoes the artist admit at step 5, but blog-rescue (step 6) still
    // admits a force-listed TJ number — the curated JP-validated whitelist is
    // deliberately NOT overridden by the guard, exactly as for the Korean case.
    const cache = emptyCache();
    cache.artistNationalityMap.星光 = jpnArtist();
    const d = classifyRecordWithReason(
      '900204',
      '明天你依然爱我',
      '星光',
      cache,
      new Set(['900204']),
    );
    expect(d.verdict).toBe('rescue');
    expect(d.step).toBe('blog-rescue');
    expect(d.reason).toBe('rescue');
  });
});

describe('parseCatalogResponse — decisions[] ↔ KeepStats consistency', () => {
  it('records one decision per classified row, consistent with the counters', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          // by-artist:
          { pro: 1, indexTitle: 't1', indexSong: 'YOASOBI', publishdate: '2020-01-01' },
          // by-pro:
          { pro: 2, indexTitle: 't2', indexSong: 'UnknownActA', publishdate: '2020-01-01' },
          // by-rescue:
          { pro: 3, indexTitle: 't3', indexSong: 'UnknownActB', publishdate: '2020-01-01' },
          // song-override (reviewed-allow tj 26544):
          { pro: 26544, indexTitle: 't4', indexSong: '東方神起', publishdate: '2020-01-01' },
          // drop via korean-drop-list:
          { pro: 5, indexTitle: 't5', indexSong: '방탄소년단', publishdate: '2020-01-01' },
          // drop via no-admit-path:
          { pro: 6, indexTitle: 't6', indexSong: 'UnknownActC', publishdate: '2020-01-01' },
          // skipped by the malformed-row guard (NOT a decision):
          { pro: null, indexTitle: 't7', indexSong: 'UnknownActD', publishdate: '2020-01-01' },
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
    const { stats, decisions } = parseCatalogResponse(json, SOURCE_URL, {
      cache,
      forceIncludeTjNumbers: new Set(['3']),
    });

    // 6 classified rows (the malformed pro:null row is skipped, not a decision).
    expect(decisions).toHaveLength(6);
    const admits = decisions.filter((d) => d.decision === 'admit');
    const drops = decisions.filter((d) => d.decision === 'drop');
    expect(admits.filter((d) => d.reason === 'artist')).toHaveLength(stats.admittedByArtist);
    expect(admits.filter((d) => d.reason === 'pro')).toHaveLength(stats.admittedByPro);
    expect(admits.filter((d) => d.reason === 'song-override')).toHaveLength(
      stats.admittedBySongOverride,
    );
    expect(admits.filter((d) => d.reason === 'rescue')).toHaveLength(stats.admittedByRescue);
    expect(drops).toHaveLength(stats.dropped);

    // no-admit-path fall-through is distinguished from an explicit step reject.
    const fallThrough = drops.find((d) => d.reason === 'no-admit-path');
    expect(fallThrough?.step).toBeNull();
    expect(fallThrough?.tj).toBe('6');
    expect(drops.find((d) => d.reason === 'korean-drop-list')?.step).toBe('drop-list-reject');
  });

  it('logs the RAW trimmed artist, not the per-song render override', () => {
    // tj 68976 (IVE) is reviewed-song-allow and its render stamps
    // artist_primary="IVE"; the decision log must keep the raw "IVE(아이브)".
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 68976, indexTitle: 'Will', indexSong: 'IVE(아이브)', publishdate: '2024-04-30' },
        ],
      },
    };
    const { records, decisions } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });
    expect(records[0]?.artist_primary).toBe('IVE');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.artist).toBe('IVE(아이브)');
    expect(decisions[0]?.decision).toBe('admit');
    expect(decisions[0]?.reason).toBe('song-override');
  });

  it('stays consistent when the script guard vetoes an artist-vote row (guard active)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          // admitted via artist (Japanese-titled, guard is a no-op):
          { pro: 1, indexTitle: 'ビバリウム', indexSong: 'Ado', publishdate: '2024-01-01' },
          // guard-vetoed Korean-script row (JPN-tagged synthetic act, empty pro):
          { pro: 2, indexTitle: '가상의 노래', indexSong: '가상밴드', publishdate: '2024-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.ado = jpnArtist();
    cache.artistNationalityMap.가상밴드 = jpnArtist();
    const { records, stats, decisions } = parseCatalogResponse(json, SOURCE_URL, { cache });

    // The Japanese-titled row admits; the Korean-script row is vetoed → dropped.
    expect(records.map((r) => r.karaoke_numbers.tj)).toEqual(['1']);
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.dropped).toBe(1);

    // decisions[] ↔ KeepStats invariant still holds with the guard active.
    const admits = decisions.filter((d) => d.decision === 'admit');
    const drops = decisions.filter((d) => d.decision === 'drop');
    expect(admits.filter((d) => d.reason === 'artist')).toHaveLength(stats.admittedByArtist);
    expect(drops).toHaveLength(stats.dropped);

    // The vetoed row is logged as a no-admit-path fall-through, not a step reject.
    const vetoed = decisions.find((d) => d.tj === '2');
    expect(vetoed?.decision).toBe('drop');
    expect(vetoed?.step).toBeNull();
    expect(vetoed?.reason).toBe('no-admit-path');
  });

  it('stays consistent when the guard vetoes a simplified-Chinese artist-vote row (guard active)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          // admitted via artist (Japanese shinjitai title, guard is a no-op):
          { pro: 1, indexTitle: '国家と桜', indexSong: 'Ado', publishdate: '2024-01-01' },
          // guard-vetoed simplified-Chinese row (JPN-tagged synthetic act, empty pro):
          { pro: 2, indexTitle: '明天你依然爱我', indexSong: '星光', publishdate: '2024-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.ado = jpnArtist();
    cache.artistNationalityMap.星光 = jpnArtist();
    const { records, stats, decisions } = parseCatalogResponse(json, SOURCE_URL, { cache });

    // The Japanese-titled row admits; the simplified-Chinese row is vetoed → dropped.
    expect(records.map((r) => r.karaoke_numbers.tj)).toEqual(['1']);
    expect(stats.admittedByArtist).toBe(1);
    expect(stats.dropped).toBe(1);

    // decisions[] ↔ KeepStats invariant still holds with the guard active.
    const admits = decisions.filter((d) => d.decision === 'admit');
    const drops = decisions.filter((d) => d.decision === 'drop');
    expect(admits.filter((d) => d.reason === 'artist')).toHaveLength(stats.admittedByArtist);
    expect(drops).toHaveLength(stats.dropped);

    // The vetoed row is logged as a no-admit-path fall-through, not a step reject.
    const vetoed = decisions.find((d) => d.tj === '2');
    expect(vetoed?.decision).toBe('drop');
    expect(vetoed?.step).toBeNull();
    expect(vetoed?.reason).toBe('no-admit-path');
  });
});

describe('classifyRecord — direct unit (keep/drop verdict)', () => {
  it('returns non-drop on path-1 hit (per-record JPN)', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['1'] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    expect(classifyRecord('1', '', 'whatever', cache) !== 'drop').toBe(true);
  });

  it('returns non-drop on path-2 hit (per-artist JPN) even without path-1 entry', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    expect(classifyRecord('1', '', 'YOASOBI', cache) !== 'drop').toBe(true);
  });

  it('returns non-drop on path-3 hit (whitelist) even without path-1/2', () => {
    const cache = emptyCache();
    expect(classifyRecord('1', '', 'whatever', cache, new Set(['1'])) !== 'drop').toBe(true);
  });

  it('returns drop when all three paths miss', () => {
    expect(classifyRecord('1', '', 'whatever', emptyCache()) === 'drop').toBe(true);
  });
});

describe('parseCatalogResponse — Phase 1 §2.E drop-list reject', () => {
  /**
   * Phase 1 §2.E drop list catches known Korean acts deterministically,
   * regardless of cache vote tallies. Applied any-component (inverse of
   * §2.B's lead-only admit rule) — Korean acts as featured artists must
   * sink Japanese-led collabs too.
   */
  it('drops a Hangul-script Korean act even when JPN-cached (drop list overrides cache)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 1, indexTitle: 'IDOL', indexSong: '방탄소년단', publishdate: '2018-08-24' }],
      },
    };
    const cache = emptyCache();
    // Pre-fix cache had `방탄소년단` JPN 3/0/0 via the JPOP-chart bootstrap.
    // Drop list MUST reject regardless.
    cache.artistNationalityMap.방탄소년단 = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('drops a kanji-script Korean act even when JPN-cached', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 2, indexTitle: 'Mirotic', indexSong: '東方神起', publishdate: '2009-07-01' },
        ],
      },
    };
    const cache = emptyCache();
    // Pre-fix cache had `東方神起` JPN 30/0/0 — the largest single kanji-script
    // leaker in the corpus. Drop list catches it.
    cache.artistNationalityMap.東方神起 = {
      code: 'JPN',
      votes: { JPN: 30, KOR: 0, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
  });

  it('drops a Latin-script BTS variant', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 3, indexTitle: 'Dynamite', indexSong: 'BTS', publishdate: '2020-08-21' }],
      },
    };
    const { records } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });
    expect(records).toEqual([]);
  });

  it('drops collab when a featured component matches the drop list (any-component rule)', () => {
    // Phase 1 §2.E behavior: a Japanese lead featuring a Korean drop-list
    // member STILL drops. Inverse of §2.B's lead-only admit rule — drop list
    // applies to all components.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 4,
            indexTitle: 'Some Track',
            indexSong: 'MAX(Feat.SUGA of BTS)',
            publishdate: '2020-01-01',
          },
        ],
      },
    };
    const cache = emptyCache();
    // MAX is the JP duo, properly JPN-tagged. Without the any-component drop
    // rule, this would admit via path 1 (lead is MAX = JPN). With the rule,
    // SUGA-of-BTS hits the drop list first and the record drops.
    cache.artistNationalityMap.max = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
  });

  it('drops collab when the lead is a Korean act with JP-tagged feature (lead is on drop list)', () => {
    // Symmetric case: Korean lead, JP feature — drop list catches the lead.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 5,
            indexTitle: 'Collab',
            indexSong: '방탄소년단(Feat.YOASOBI)',
            publishdate: '2024-01-01',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtist();
    const { records } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
  });

  it('does NOT drop a non-list Japanese act with similar surface form', () => {
    // Sanity: LiSA is a real JP act, NOT on the drop list. The drop-list
    // catch must not bleed.
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 6, indexTitle: 'oath sign', indexSong: 'LiSA', publishdate: '2011-10-12' }],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.lisa = jpnArtist();
    const { records } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(1);
    expect(records[0]?.artist_primary).toBe('LiSA');
  });

  it('drops the PR #95 leaker `루시` (LUCY) even when the artist scan tagged it JPN', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 32100, indexTitle: '1년 365일', indexSong: '루시', publishdate: '2023-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    // PR #95 weekly crawl: the artist scan voted `루시` JPN 3/0/0 while the
    // per-song proEnrichment tagged the rows KOR. Drop list rejects regardless.
    cache.artistNationalityMap.루시 = {
      code: 'JPN',
      votes: { JPN: 3, KOR: 0, ENG: 0 },
      lastSeen: '2026-07-08T04:41:07.835Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('drops the `루시(Feat.원슈타인)` collab via its lead component (any-component scan)', () => {
    // splitArtistCollab('루시(Feat.원슈타인)') -> ['루시(Feat.원슈타인)', '루시',
    // '원슈타인']. The collab whole-string is UNKNOWN in cache, but the lead
    // component `루시` is on the drop list and drop-list-reject scans every
    // component, so the row drops.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 900571,
            indexTitle: 'Collab Track',
            indexSong: '루시(Feat.원슈타인)',
            publishdate: '2024-01-01',
          },
        ],
      },
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
  });

  it('drops the PR #95 leaker `로이킴` (Roy Kim) even when the artist scan tagged it JPN', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 36707, indexTitle: '봄봄봄', indexSong: '로이킴', publishdate: '2013-04-01' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.로이킴 = {
      code: 'JPN',
      votes: { JPN: 4, KOR: 0, ENG: 0 },
      lastSeen: '2026-07-08T04:41:07.835Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('drops the Latin-script PR #95 leaker `BOYNEXTDOOR` even when the artist scan tagged it JPN', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 43349,
            indexTitle: 'Nice Guy',
            indexSong: 'BOYNEXTDOOR',
            publishdate: '2023-05-30',
          },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.boynextdoor = {
      code: 'JPN',
      votes: { JPN: 4, KOR: 0, ENG: 0 },
      lastSeen: '2026-07-08T04:41:07.835Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });
});

describe('parseCatalogResponse — Chinese-artist drop-list reject', () => {
  /**
   * Cantopop / Mandopop drop list (chineseArtistDropList.ts) — same any-component
   * scan as the Korean drop list. These acts have no Japan presence at all,
   * so the cache vote-tally signal can't demote them; the drop list is the
   * only deterministic gate.
   */
  it('drops a record with `BEYOND` as artist (Cantopop leaker)', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [{ pro: 70170, indexTitle: '大地', indexSong: 'BEYOND', publishdate: '2000-01-01' }],
      },
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache: emptyCache() });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('admits a real Japanese act (`米津玄師`) when the drop list is wired in', () => {
    // Sanity: the Chinese drop list MUST NOT bleed onto Japanese acts. 米津玄師
    // is a real JP act — admit via per-artist JPN tag.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 12345, indexTitle: 'Lemon', indexSong: '米津玄師', publishdate: '2018-03-14' },
        ],
      },
    };
    const cache = emptyCache();
    cache.artistNationalityMap.米津玄師 = jpnArtist();
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toHaveLength(1);
    expect(records[0]?.artist_primary).toBe('米津玄師');
    expect(stats.admittedByArtist).toBe(1);
  });
});

describe('parseCatalogResponse — Phase 1 §2.C per-pro KOR-reject', () => {
  /**
   * Phase 1 §2.C: an explicit `nationalcode === 'KOR'` on `proEnrichmentMap`
   * overrides every admit path including the blog rescue. A hand-validated
   * blog mention can lag a TJ catalog metadata correction.
   */
  it('drops a record whose pro is KOR-tagged, before path 1 (per-artist) fires', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 100, indexTitle: 'Spring Day', indexSong: 'KorAct', publishdate: '2017-02-13' },
        ],
      },
    };
    const cache = emptyCache();
    // The artist scan (incorrectly) tagged KorAct as JPN. The pro-level KOR
    // signal MUST override.
    cache.artistNationalityMap.koract = jpnArtist();
    cache.proEnrichmentMap['100'] = {
      nationalcode: 'KOR',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records, stats } = parseCatalogResponse(json, SOURCE_URL, { cache });
    expect(records).toEqual([]);
    expect(stats.dropped).toBe(1);
    expect(stats.admittedByArtist).toBe(0);
  });

  it('drops a record whose pro is KOR-tagged even when the rescue whitelist contains it', () => {
    // Path 4 (rescue) does NOT override an explicit KOR signal.
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 200, indexTitle: 'Some Track', indexSong: 'AnyArtist', publishdate: '2020-01-01' },
        ],
      },
    };
    const cache = emptyCache();
    cache.proEnrichmentMap['200'] = {
      nationalcode: 'KOR',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const { records } = parseCatalogResponse(json, SOURCE_URL, {
      cache,
      forceIncludeTjNumbers: new Set(['200']),
    });
    expect(records).toEqual([]);
  });
});

describe('parseCatalogResponse — KeepStats per-path admit counters', () => {
  /**
   * Reading order: reviewed song/pro evidence → artist → blog whitelist.
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

  it('per-record exact evidence beats per-artist when both tags say JPN (reading-order check)', () => {
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
    expect(stats.admittedByArtist).toBe(0);
    expect(stats.admittedByPro).toBe(1);
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
