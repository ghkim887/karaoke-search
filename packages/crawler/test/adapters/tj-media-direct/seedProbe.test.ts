import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildBlogSeed,
  loadBlogSeedFromCorpus,
} from '../../../src/adapters/tj-media-direct/blogWhitelist.js';
import type { SearchSongCache } from '../../../src/adapters/tj-media-direct/cache.js';
import {
  BLOG_SEED_PROBE_CAP,
  type SeedProbeStats,
  probeBlogSeedNumbers,
} from '../../../src/adapters/tj-media-direct/seedProbe.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

const SOURCE_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';

function emptyCache(): SearchSongCache {
  return { version: 1, generatedAt: '', proEnrichmentMap: {}, artistNationalityMap: {} };
}

interface ProbeItem {
  pro: string | number;
  indexTitle: string;
  indexSong: string;
  nationalcode?: string;
  sortTitleKo?: string;
  sortSongKo?: string;
}
type ProbeResp = ProbeItem | 'miss' | 'error';

/** Mock http whose `postForm` answers a searchSongByPro (strType=16) call by
 * looking up `body.searchTxt` (the pro) in `map`. */
function buildHttp(map: Record<string, ProbeResp>, calls?: string[]): Pick<HttpClient, 'postForm'> {
  return {
    async postForm(_url, body): Promise<FetchResult | null> {
      const pro = body.searchTxt;
      calls?.push(pro);
      const r = map[pro];
      if (r === 'error') return { status: 500, body: 'boom' };
      if (r === undefined || r === 'miss') {
        return {
          status: 200,
          body: JSON.stringify({ resultCode: '98', resultData: { items: [] } }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          resultCode: '99',
          resultData: {
            items: [{ subTitle: '', sortTitleKo: '', sortSongKo: '', publishdate: '', ...r }],
          },
        }),
      };
    },
  };
}

const throwingHttp: Pick<HttpClient, 'postForm'> = {
  async postForm(): Promise<FetchResult | null> {
    throw new Error('http must not be called');
  },
};

describe('buildBlogSeed', () => {
  it('derives blog-claimed TJ numbers, excluding non-blog ids and null-tj rows', () => {
    const seed = buildBlogSeed([
      { id: 'blog-1-tj-100', artist_primary: null, karaoke_numbers: { tj: '100' } },
      // blog-origin but minted from joysound — still carries a claimed tj.
      { id: 'blog-2-joysound-9', artist_primary: null, karaoke_numbers: { tj: '200' } },
      // legacy positional blog id — prefix-only detection includes it.
      { id: 'blog-449-0', artist_primary: null, karaoke_numbers: { tj: '500' } },
      // blog row with no tj claim — excluded.
      { id: 'blog-3-joysound-5', artist_primary: null, karaoke_numbers: { tj: null } },
      // non-blog ids — excluded even though they carry a tj.
      { id: 'tj-300', artist_primary: null, karaoke_numbers: { tj: '300' } },
      { id: 'joysound-9', artist_primary: null, karaoke_numbers: { tj: '400' } },
    ]);
    expect([...seed].sort()).toEqual(['100', '200', '500']);
  });
});

describe('loadBlogSeedFromCorpus', () => {
  it('returns an empty set when the corpus file is missing (no hard failure)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seed = loadBlogSeedFromCorpus(join(tmpdir(), `no-such-corpus-${Date.now()}.json`));
    expect(seed.size).toBe(0);
    warn.mockRestore();
  });

  it('derives the seed from a corpus file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blog-seed-'));
    try {
      const path = join(dir, 'songs.json');
      await writeFile(
        path,
        JSON.stringify([
          { id: 'blog-1-tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: null } },
          { id: 'tj-300', karaoke_numbers: { tj: '300', ky: null, joysound: null } },
        ]),
        'utf8',
      );
      const seed = loadBlogSeedFromCorpus(path);
      expect([...seed]).toEqual(['100']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('probeBlogSeedNumbers', () => {
  it("subtracts this run's already-crawled TJ numbers before probing", async () => {
    const calls: string[] = [];
    const http = buildHttp(
      { '200': { pro: '200', indexTitle: 'T', indexSong: 'A', nationalcode: 'JPN' } },
      calls,
    );
    const { stats } = await probeBlogSeedNumbers(
      http,
      new Set(['100', '200']),
      new Set(['100']), // already crawled → subtracted
      emptyCache(),
      SOURCE_URL,
    );
    expect(calls).toEqual(['200']); // 100 never probed
    expect(stats.skippedAlreadyCrawled).toBe(1);
    expect(stats.probed).toBe(1);
  });

  it('emits a tj record for a JPN probe hit (admitted through classification) and enriches the cache', async () => {
    const cache = emptyCache();
    const http = buildHttp({
      '26723': {
        pro: '26723',
        indexTitle: '青のすみか',
        indexSong: 'キタニタツヤ',
        nationalcode: 'JPN',
      },
    });
    const { records, stats } = await probeBlogSeedNumbers(
      http,
      new Set(['26723']),
      new Set(),
      cache,
      SOURCE_URL,
    );
    expect(stats.hits).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]?.karaoke_numbers.tj).toBe('26723');
    expect(records[0]?.title_primary).toBe('青のすみか');
    expect(records[0]?.artist_primary).toBe('キタニタツヤ');
    // Mirrors jpLikelyRescue: the JPN hit is admitted to the enrichment cache.
    expect(cache.proEnrichmentMap['26723']?.nationalcode).toBe('JPN');
  });

  it('admits a hit whose tj is in the force whitelist (rescue path) regardless of nationalcode', async () => {
    const http = buildHttp({
      '52784': { pro: '52784', indexTitle: 'うつくしい世界', indexSong: 'Aimer', nationalcode: '' },
    });
    const { records, stats } = await probeBlogSeedNumbers(
      http,
      new Set(['52784']),
      new Set(),
      emptyCache(),
      SOURCE_URL,
      new Set(['52784']), // force whitelist
    );
    expect(stats.hits).toBe(1);
    expect(records[0]?.karaoke_numbers.tj).toBe('52784');
  });

  it('does NOT emit a probe hit the filter chain drops (filtered, not admitted)', async () => {
    // Non-JPN, not in force, unknown artist → no admit path → drop.
    const http = buildHttp({
      '99999': { pro: '99999', indexTitle: '아무노래', indexSong: '지코', nationalcode: 'KOR' },
    });
    const { records, stats } = await probeBlogSeedNumbers(
      http,
      new Set(['99999']),
      new Set(),
      emptyCache(),
      SOURCE_URL,
    );
    expect(stats.filtered).toBe(1);
    expect(stats.hits).toBe(0);
    expect(records).toHaveLength(0);
  });

  it('skips a probe miss (no TJ record for the number) and counts an error apart', async () => {
    const http = buildHttp({ '111': 'miss', '222': 'error' });
    const { records, stats } = await probeBlogSeedNumbers(
      http,
      new Set(['111', '222']),
      new Set(),
      emptyCache(),
      SOURCE_URL,
    );
    expect(records).toHaveLength(0);
    expect(stats.misses).toBe(1);
    expect(stats.errors).toBe(1);
  });

  it('caps the probe at `cap` (sorted) and warns loudly on truncation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const http = buildHttp({}, calls); // everything is a miss
    const { stats } = await probeBlogSeedNumbers(
      http,
      new Set(['3', '1', '2']),
      new Set(),
      emptyCache(),
      SOURCE_URL,
      undefined,
      2, // cap
    );
    expect(calls).toEqual(['1', '2']); // sorted, first 2
    expect(stats.probed).toBe(2);
    expect(stats.truncated).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds cap 2'));
    warn.mockRestore();
  });

  it('empty seed is a no-op: zero probes, zero records (crawl byte-identical pin)', async () => {
    const result: { records: unknown[]; stats: SeedProbeStats } = await probeBlogSeedNumbers(
      throwingHttp, // asserts http is never called
      new Set(),
      new Set(['100', '200']),
      emptyCache(),
      SOURCE_URL,
    );
    expect(result.records).toEqual([]);
    expect(result.stats.probed).toBe(0);
    expect(result.stats.hits).toBe(0);
    expect(BLOG_SEED_PROBE_CAP).toBe(500);
  });
});
