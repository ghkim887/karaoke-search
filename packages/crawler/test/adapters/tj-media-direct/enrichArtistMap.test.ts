import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { emptyCache, loadCache, saveCache } from '../../../src/adapters/tj-media-direct/cache.js';
import { enrichArtistMap } from '../../../src/adapters/tj-media-direct/enrichArtistMap.js';
import { classifyRecord } from '../../../src/adapters/tj-media-direct/parser.js';
import {
  isReviewedTjSongAllow,
  isReviewedTjSongDrop,
} from '../../../src/adapters/tj-media-direct/reviewedSongOverrides.js';
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
    // Phase 1 §2.A: KOR requires ≥3 votes AND ratio ≥ 0.7. 3/0 hits both.
    const records = [rawFor({ tj: '1', artist: 'BTS' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 1, indexTitle: 't1', indexSong: 'BTS', nationalcode: 'KOR' },
        { pro: 2, indexTitle: 't2', indexSong: 'BTS', nationalcode: 'KOR' },
        { pro: 3, indexTitle: 't3', indexSong: 'BTS', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.artistNationalityMap.bts?.code).toBe('KOR');
  });

  it('classifies a mixed-vote artist as AMBIGUOUS', async () => {
    // Phase 1 §2.A: AMBIGUOUS requires ≥3 votes on BOTH sides AND neither
    // side hits the 0.7 ratio. 3 JPN + 3 KOR = 0.5 ratio each side.
    const records = [rawFor({ tj: '1', artist: 'AmbiguousAct' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 1, indexTitle: 't1', indexSong: 'AmbiguousAct', nationalcode: 'JPN' },
        { pro: 2, indexTitle: 't2', indexSong: 'AmbiguousAct', nationalcode: 'JPN' },
        { pro: 3, indexTitle: 't3', indexSong: 'AmbiguousAct', nationalcode: 'JPN' },
        { pro: 4, indexTitle: 't4', indexSong: 'AmbiguousAct', nationalcode: 'KOR' },
        { pro: 5, indexTitle: 't5', indexSong: 'AmbiguousAct', nationalcode: 'KOR' },
        { pro: 6, indexTitle: 't6', indexSong: 'AmbiguousAct', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    const entry = cache.artistNationalityMap.ambiguousact;
    expect(entry?.code).toBe('AMBIGUOUS');
    expect(entry?.votes.JPN).toBe(3);
    expect(entry?.votes.KOR).toBe(3);
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
    // Phase 1 §2.A: JPN requires ≥3 votes; bump fixture to 3 normalized hits.
    const records = [rawFor({ tj: '1', artist: 'YOASOBI' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      // TJ returned a different case + extra whitespace — must still
      // exact-match after normalize. 3 votes to clear the threshold.
      searchResp([
        { pro: 1, indexTitle: 't1', indexSong: 'yo  asobi', nationalcode: 'JPN' },
        { pro: 2, indexTitle: 't2', indexSong: 'YOASOBI', nationalcode: 'JPN' },
        { pro: 3, indexTitle: 't3', indexSong: 'Yo Asobi', nationalcode: 'JPN' },
      ]),
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
      // Phase 1 §2.A: JPN now requires ≥3 votes to classify confidently.
      if (searchTxt === 'imase') {
        return searchResp([
          { pro: 1, indexTitle: 't1', indexSong: 'imase', nationalcode: 'JPN' },
          { pro: 2, indexTitle: 't2', indexSong: 'imase', nationalcode: 'JPN' },
          { pro: 3, indexTitle: 't3', indexSong: 'imase', nationalcode: 'JPN' },
        ]);
      }
      if (searchTxt === 'なとり') {
        return searchResp([
          { pro: 4, indexTitle: 't1', indexSong: 'なとり', nationalcode: 'JPN' },
          { pro: 5, indexTitle: 't2', indexSong: 'なとり', nationalcode: 'JPN' },
          { pro: 6, indexTitle: 't3', indexSong: 'なとり', nationalcode: 'JPN' },
        ]);
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
      // 3 votes → JPN under the §2.A threshold rule.
      searchResp([
        { pro: 1, indexTitle: 't1', indexSong: 'YOASOBI', nationalcode: 'JPN' },
        { pro: 2, indexTitle: 't2', indexSong: 'YOASOBI', nationalcode: 'JPN' },
        { pro: 3, indexTitle: 't3', indexSong: 'YOASOBI', nationalcode: 'JPN' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(calls).toHaveLength(1);
  });
});

describe('verdictFromVotes — Phase 1 §2.A threshold rule', () => {
  /**
   * The verdict function isn't exported, so we exercise it through the
   * scanner. Each case fabricates a `searchSong` response with the exact
   * vote distribution we want and checks the resulting `code`.
   *
   * Phase 1 §2.A rule (KPOP-leak fix, 2026-05-01):
   *   - JPN: `JPN ≥ 3 AND JPN/(JPN+KOR) ≥ 0.7`
   *   - KOR: `KOR ≥ 3 AND KOR/(JPN+KOR) ≥ 0.7` (symmetric)
   *   - AMBIGUOUS: both have ≥3 votes but neither hits 0.7 ratio
   *   - UNKNOWN: insufficient signal
   */
  function buildVotes(distribution: { JPN?: number; KOR?: number }): Array<
    Record<string, unknown>
  > {
    const items: Array<Record<string, unknown>> = [];
    let pro = 1;
    for (let i = 0; i < (distribution.JPN ?? 0); i++) {
      items.push({
        pro: pro++,
        indexTitle: `t${pro}`,
        indexSong: 'TestArtist',
        nationalcode: 'JPN',
      });
    }
    for (let i = 0; i < (distribution.KOR ?? 0); i++) {
      items.push({
        pro: pro++,
        indexTitle: `t${pro}`,
        indexSong: 'TestArtist',
        nationalcode: 'KOR',
      });
    }
    return items;
  }

  async function verdictFor(distribution: { JPN?: number; KOR?: number }): Promise<string> {
    const records = [rawFor({ tj: '1', artist: 'TestArtist' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() => searchResp(buildVotes(distribution)));
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    return cache.artistNationalityMap.testartist?.code ?? '<missing>';
  }

  it('JPN 2/0 votes → UNKNOWN (below ≥3 threshold)', async () => {
    expect(await verdictFor({ JPN: 2, KOR: 0 })).toBe('UNKNOWN');
  });

  it('JPN 3/0 votes → JPN (3 votes, ratio 1.0)', async () => {
    expect(await verdictFor({ JPN: 3, KOR: 0 })).toBe('JPN');
  });

  it('JPN 3/2 votes → UNKNOWN (3 JPN votes but ratio 0.6 fails 0.7 bar; KOR side has only 2 votes — not symmetric AMBIGUOUS)', async () => {
    expect(await verdictFor({ JPN: 3, KOR: 2 })).toBe('UNKNOWN');
  });

  it('JPN 4/2 votes → UNKNOWN (4 JPN, ratio 0.67 fails 0.7 bar; KOR side has only 2 votes)', async () => {
    expect(await verdictFor({ JPN: 4, KOR: 2 })).toBe('UNKNOWN');
  });

  it('JPN 7/3 votes → JPN (10 votes, ratio 0.7 hits the bar exactly)', async () => {
    expect(await verdictFor({ JPN: 7, KOR: 3 })).toBe('JPN');
  });

  it('KOR 3/0 votes → KOR (symmetric — needed because §2.F seeds KOR votes)', async () => {
    expect(await verdictFor({ KOR: 3, JPN: 0 })).toBe('KOR');
  });

  it('KOR 7/3 votes → KOR (symmetric ratio rule, 0.7 ratio)', async () => {
    expect(await verdictFor({ KOR: 7, JPN: 3 })).toBe('KOR');
  });

  it('JPN 3/3 votes → AMBIGUOUS (both sides ≥3, neither hits 0.7)', async () => {
    expect(await verdictFor({ JPN: 3, KOR: 3 })).toBe('AMBIGUOUS');
  });

  it('JPN 5/3 votes → AMBIGUOUS (both sides ≥3, ratio 0.625 < 0.7)', async () => {
    expect(await verdictFor({ JPN: 5, KOR: 3 })).toBe('AMBIGUOUS');
  });

  it('0/0 votes → UNKNOWN', async () => {
    expect(await verdictFor({ JPN: 0, KOR: 0 })).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// Item A — persist non-JPN nationalcode into proEnrichmentMap for ALL rows.
//
// The per-artist scan's searchSong items each carry an authoritative `pro` +
// `nationalcode`. Pre-fix, only KEPT (JPN) survivors got a `proEnrichmentMap`
// entry (written by enrichTranslit / the JP-likely rescue), so the strongest
// negative signal `non-jpn-pro-reject` had ~0 cached KOR/ENG data to act on in
// steady state. The scan now persists the authoritative non-JPN code per exact
// pro so the veto has data — and we avoid re-fetching/re-voting next crawl.
// ---------------------------------------------------------------------------

describe('enrichArtistMap — persist non-JPN proEnrichmentMap entries (Item A)', () => {
  it('persists an authoritative KOR nationalcode into proEnrichmentMap keyed by the exact pro', async () => {
    const records = [rawFor({ tj: '1', artist: 'BTS' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 28779, indexTitle: 't1', indexSong: 'BTS', nationalcode: 'KOR' },
        { pro: 28780, indexTitle: 't2', indexSong: 'BTS', nationalcode: 'KOR' },
        { pro: 28781, indexTitle: 't3', indexSong: 'BTS', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });

    // The artist is classified KOR (as before)...
    expect(cache.artistNationalityMap.bts?.code).toBe('KOR');
    // ...AND each scanned KOR row now lands in proEnrichmentMap under its exact
    // pro (the same key shape classifyRecord/non-jpn-pro-reject reads: the
    // stringified TJ catalog number). Previously these were dropped entirely.
    expect(cache.proEnrichmentMap['28779']?.nationalcode).toBe('KOR');
    expect(cache.proEnrichmentMap['28780']?.nationalcode).toBe('KOR');
    expect(cache.proEnrichmentMap['28781']?.nationalcode).toBe('KOR');
    // lastSeen is stamped so the 90-day TTL applies to these entries too.
    expect(cache.proEnrichmentMap['28779']?.lastSeen).toBe('2026-04-29T00:00:00.000Z');
  });

  it('persists an authoritative ENG nationalcode too (non-JPN, not just KOR)', async () => {
    const records = [rawFor({ tj: '1', artist: 'Ed Sheeran' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([{ pro: 50001, indexTitle: 't1', indexSong: 'Ed Sheeran', nationalcode: 'ENG' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.proEnrichmentMap['50001']?.nationalcode).toBe('ENG');
  });

  it('does NOT persist a JPN nationalcode from the artist scan (JPN write stays owned by the translit pass)', async () => {
    // The translit pass + JP-likely rescue own the JPN proEnrichmentMap writes
    // (they carry the full sortTitleKo/sortSongKo payload for kept rows). The
    // artist scan only feeds the negative-signal veto, so it must NOT shadow a
    // JPN pro with a payload-less stub.
    const records = [rawFor({ tj: '1', artist: 'YOASOBI' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 60001, indexTitle: 't1', indexSong: 'YOASOBI', nationalcode: 'JPN' },
        { pro: 60002, indexTitle: 't2', indexSong: 'YOASOBI', nationalcode: 'JPN' },
        { pro: 60003, indexTitle: 't3', indexSong: 'YOASOBI', nationalcode: 'JPN' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.artistNationalityMap.yoasobi?.code).toBe('JPN');
    expect(cache.proEnrichmentMap['60001']).toBeUndefined();
    expect(cache.proEnrichmentMap['60002']).toBeUndefined();
  });

  it('only persists codes tied to an EXACT artist match — no fuzzy/neighbor leak', async () => {
    // A KOR artist query returns one exact-match row AND one row by a DIFFERENT
    // artist (search index noise). Only the exact-match pro is cached; the
    // unrelated neighbor row's pro must NOT be persisted under this artist.
    const records = [rawFor({ tj: '1', artist: 'BTS' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        { pro: 28779, indexTitle: 't1', indexSong: 'BTS', nationalcode: 'KOR' },
        // Different artist surfaced by the search index — NOT an exact match.
        { pro: 99999, indexTitle: 'noise', indexSong: 'SomeOtherAct', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.proEnrichmentMap['28779']?.nationalcode).toBe('KOR');
    expect(cache.proEnrichmentMap['99999']).toBeUndefined();
  });

  it('skips items carrying no nationalcode (null) — nothing to veto with', async () => {
    const records = [rawFor({ tj: '1', artist: 'UntaggedAct' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([{ pro: 70001, indexTitle: 't1', indexSong: 'UntaggedAct' }]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });
    expect(cache.proEnrichmentMap['70001']).toBeUndefined();
  });

  it('LOAD-BEARING: non-jpn-pro-reject now vetoes a row whose pro the scan cached as KOR, even when the artist path (step 5) would admit it', async () => {
    // Construct the exact leak the fix closes: a record whose artist the cache
    // would (hypothetically) classify JPN — the weaker positive admit path
    // jpn-admit-artist (step 5) — but whose SPECIFIC pro was discovered as KOR
    // during the artist scan. With the scan now persisting that KOR code,
    // non-jpn-pro-reject (step 1) fires BEFORE jpn-admit-artist (step 5) and
    // drops the row.
    //
    // The TJ number MUST be off both reviewed-song override lists: a number on
    // REVIEWED_TJ_SONG_ALLOW would admit at reviewed-song-allow (step 2) — never
    // descending to step 5 — and the assertion would prove "step 1 beats step 2"
    // instead of the documented "step 1 beats step 5". `91234` is verified clean
    // against reviewedSongOverrides.ts (ALLOW range ends at 68976; not on the
    // 10-entry DROP list). Pin that invariant so the test can never silently
    // regress to short-circuiting at step 2.
    const TJ = '91234';
    expect(isReviewedTjSongAllow(TJ)).toBe(false);
    expect(isReviewedTjSongDrop(TJ)).toBe(false);

    const records = [rawFor({ tj: TJ, artist: 'MixedSignalAct' })];
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    const { client } = buildHttp(() =>
      searchResp([
        // Exact-match row tagged KOR — this populates proEnrichmentMap['91234'].
        { pro: 91234, indexTitle: 't1', indexSong: 'MixedSignalAct', nationalcode: 'KOR' },
      ]),
    );
    await enrichArtistMap(client, records, cache, {
      now: new Date('2026-04-29T00:00:00.000Z'),
      logger: silentLogger(),
    });

    // Sanity: the scan persisted the KOR veto datum.
    expect(cache.proEnrichmentMap[TJ]?.nationalcode).toBe('KOR');

    // Force the weaker positive admit path to be live: tag the artist JPN so
    // that, absent the pro veto, jpn-admit-artist (step 5) WOULD admit. With
    // TJ off both override lists, the row genuinely descends to step 5 pre-fix,
    // so this setup is the path being overridden (not dead code).
    cache.artistNationalityMap.mixedsignalact = {
      code: 'JPN',
      votes: { JPN: 3, KOR: 0, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };

    // The veto now has data → drop. Pre-fix proEnrichmentMap['91234'] was empty,
    // step 1 passed, steps 2-4 passed, and jpn-admit-artist (step 5) admitted —
    // the KOR row leaked.
    expect(classifyRecord(TJ, 't1', 'MixedSignalAct', cache)).toBe('drop');
  });

  it('round-trips the new non-JPN entries through saveCache/loadCache (exact pro key only)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tj-itemA-'));
    try {
      const records = [rawFor({ tj: '1', artist: 'BTS' })];
      const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
      const { client } = buildHttp(() =>
        searchResp([
          { pro: 28779, indexTitle: 't1', indexSong: 'BTS', nationalcode: 'KOR' },
          { pro: 28780, indexTitle: 't2', indexSong: 'BTS', nationalcode: 'KOR' },
          { pro: 28781, indexTitle: 't3', indexSong: 'BTS', nationalcode: 'KOR' },
        ]),
      );
      await enrichArtistMap(client, records, cache, {
        now: new Date('2026-04-29T00:00:00.000Z'),
        logger: silentLogger(),
      });

      const path = join(dir, 'tj-search-cache.json');
      await saveCache(path, cache);
      const reloaded = await loadCache(path);
      expect(reloaded.proEnrichmentMap['28779']?.nationalcode).toBe('KOR');
      expect(reloaded.proEnrichmentMap['28780']?.nationalcode).toBe('KOR');
      expect(reloaded.proEnrichmentMap['99999']).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
