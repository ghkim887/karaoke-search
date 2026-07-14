import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TJDirectCrawler } from '../../../src/adapters/tj-media-direct/crawler.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/catalog-sample.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const FIXTURE = JSON.parse(FIXTURE_TEXT);

const CATALOG_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';

interface Captured {
  url: string;
  body: Record<string, string>;
}

function buildHttp(opts: {
  status?: number;
  body?: string;
  captured?: Captured[];
  postFormImpl?: HttpClient['postForm'];
}): Pick<HttpClient, 'postForm'> {
  const captured = opts.captured;
  return {
    async postForm(url, body): Promise<FetchResult | null> {
      if (captured) captured.push({ url, body: { ...body } });
      if (opts.postFormImpl) return opts.postFormImpl(url, body);
      return { status: opts.status ?? 200, body: opts.body ?? FIXTURE_TEXT };
    },
  };
}

const emptyWhitelist = (): ReadonlySet<string> => new Set<string>();
// Empty blog reverse-probe seed: opts an enrichment-enabled test out of the
// always-on seed probe (which otherwise reads the real corpus), the same way
// `emptyWhitelist` opts out of the force whitelist.
const emptySeed = (): ReadonlySet<string> => new Set<string>();

/**
 * Build a pre-seeded cache file at `cachePath` that tags every fixture
 * artist as JPN, so the parser's path-2 admits all fixture records. Also
 * marks the bootstrap as "fresh" so the crawler skips the chart sweep.
 */
async function seedCacheForFixture(cachePath: string): Promise<void> {
  const lastSeen = new Date().toISOString();
  const artistNationalityMap: Record<
    string,
    { code: 'JPN'; votes: { JPN: number; KOR: number; ENG: number }; lastSeen: string }
  > = {};
  for (const item of FIXTURE.resultData.items) {
    if (typeof item.indexSong !== 'string') continue;
    const key = item.indexSong.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
    if (key === '') continue;
    artistNationalityMap[key] = {
      code: 'JPN',
      votes: { JPN: 1, KOR: 0, ENG: 0 },
      lastSeen,
    };
  }
  const proEnrichmentMap: Record<
    string,
    {
      nationalcode: string;
      sortTitleKo: string | null;
      sortSongKo: string | null;
      subTitle: string | null;
      publishdate: string | null;
      lastSeen: string;
    }
  > = {};
  for (const item of FIXTURE.resultData.items) {
    if (typeof item.pro !== 'number' && typeof item.pro !== 'string') continue;
    const pro = String(item.pro);
    proEnrichmentMap[pro] = {
      nationalcode: 'JPN',
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen,
    };
  }
  const seeded = {
    version: 1,
    generatedAt: lastSeen,
    proEnrichmentMap,
    artistNationalityMap,
  };
  await writeFile(cachePath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');
}

async function seedFreshEmptyCache(cachePath: string): Promise<void> {
  const now = new Date().toISOString();
  await writeFile(
    cachePath,
    `${JSON.stringify(
      {
        version: 2,
        generatedAt: now,
        bootstrappedAt: now,
        proEnrichmentMap: {},
        artistNationalityMap: {},
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

describe('TJDirectCrawler.crawl — fixture-stub HTTP', () => {
  it('issues a single POST to the catalog endpoint with searchYm=200001 (disableEnrichment: empty cache drops everything except whitelist)', async () => {
    const captured: Captured[] = [];
    const http = buildHttp({ captured });
    // With disableEnrichment + empty whitelist + empty cache (no on-disk
    // file), the parser's 3-path filter drops every record. We assert this
    // documents-the-behavior rather than the legacy "30 records" count.
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
        disableEnrichment: true,
        cachePath,
      });
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);

      expect(captured.length).toBe(1);
      expect(captured[0]?.url).toBe(CATALOG_URL);
      expect(captured[0]?.body).toEqual({ searchYm: '200001' });
      expect(records.length).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('with seeded cache: every emitted record has a TJ number set and tj/ky/joysound shape', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      await seedCacheForFixture(cachePath);
      const http = buildHttp({});
      const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
        disableEnrichment: true,
        cachePath,
      });
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);

      // The fixture has 51 items but several of them have empty pro/title/
      // artist or are otherwise skipped by the basic shape gate. Don't
      // hardcode 51 — just assert the count is reasonable and the shape is
      // correct.
      expect(records.length).toBeGreaterThan(0);
      for (const r of records) {
        expect(r.karaoke_numbers.tj).toMatch(/^\d+$/);
        expect(r.karaoke_numbers.ky).toBeNull();
        expect(r.karaoke_numbers.joysound).toBeNull();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('honors options.limit by capping yielded records', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      await seedCacheForFixture(cachePath);
      const http = buildHttp({});
      const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
        disableEnrichment: true,
        cachePath,
      });
      const records = [];
      for await (const r of crawler.crawl({ limit: 5 })) records.push(r);
      expect(records.length).toBe(5);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when the HTTP layer returns a non-2xx status', async () => {
    const http = buildHttp({ status: 503, body: '<html>Service Unavailable</html>' });
    const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
      disableEnrichment: true,
    });
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the body is not valid JSON', async () => {
    const http = buildHttp({ status: 200, body: 'not json {{{' });
    const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
      disableEnrichment: true,
    });
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the response shape is unexpected (missing resultData)', async () => {
    const http = buildHttp({ status: 200, body: JSON.stringify({ resultCode: '00' }) });
    const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
      disableEnrichment: true,
    });
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/resultData/);
  });

  it('throws when robots.txt disallows the URL (postForm returns null)', async () => {
    const http = buildHttp({
      postFormImpl: async () => null,
    });
    const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
      disableEnrichment: true,
    });
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/robots\.txt/);
  });
});

describe('TJDirectCrawler.crawl — blog-whitelist rescue (path 3)', () => {
  it('rescues an all-Latin Japanese act when its TJ# is in the blog whitelist (cache empty)', async () => {
    const body = JSON.stringify({
      resultCode: '00',
      resultData: {
        itemsTotalCount: 3,
        items: [
          // (1) all-Latin Japanese — admitted via whitelist (path 3).
          {
            pro: 11111,
            indexTitle: 'Trash Candy',
            indexSong: 'GRANRODEO',
            publishdate: '2016-01-27',
          },
          // (2) Mandopop — no path admits, drops.
          {
            pro: 22222,
            indexTitle: '吻別',
            indexSong: '张学友',
            publishdate: '1993-03-08',
          },
          // (3) Regular Japanese (kana) — also drops without cache help.
          {
            pro: 33333,
            indexTitle: 'アイドル',
            indexSong: 'YOASOBI',
            publishdate: '2023-05-24',
          },
        ],
      },
    });
    const http = buildHttp({ status: 200, body });
    const whitelist = (): ReadonlySet<string> => new Set(['11111']);
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      const crawler = new TJDirectCrawler(http as HttpClient, whitelist, {
        disableEnrichment: true,
        cachePath,
      });
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);

      expect(records.length).toBe(1);
      expect(records[0]?.karaoke_numbers.tj).toBe('11111');
      expect(records[0]?.artist_primary).toBe('GRANRODEO');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('TJDirectCrawler.crawl — JP-likely drop rescue', () => {
  it('rescues a kana-bearing dropped record when exact pro search confirms it as JPN', async () => {
    const catalogBody = JSON.stringify({
      resultCode: '99',
      resultData: {
        itemsTotalCount: 1,
        items: [
          {
            pro: 68781,
            indexTitle: 'アイドル',
            indexSong: 'YOASOBI',
            publishdate: '2023-05-24',
          },
        ],
      },
    });
    const titleSearchBody = JSON.stringify({
      resultCode: '99',
      resultData: {
        itemsTotalCount: 1,
        items: [
          {
            pro: 68781,
            indexTitle: 'アイドル',
            indexSong: 'YOASOBI',
            sortTitleKo: '아이도루',
            sortSongKo: '요아소비',
            nationalcode: 'JPN',
            publishdate: '2023-05-24',
          },
        ],
      },
    });
    const emptySearchBody = JSON.stringify({ resultCode: '98', resultData: { items: [] } });
    const captured: Captured[] = [];
    const http = buildHttp({
      captured,
      postFormImpl: async (url, body) => {
        if (url.includes('newSongOfMonth')) return { status: 200, body: catalogBody };
        if (body.strType === '2') return { status: 200, body: emptySearchBody };
        return { status: 200, body: titleSearchBody };
      },
    });
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      await seedFreshEmptyCache(cachePath);
      const crawler = new TJDirectCrawler(
        http as HttpClient,
        emptyWhitelist,
        { cachePath },
        emptySeed,
      );
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);

      expect(records).toHaveLength(1);
      expect(records[0]?.karaoke_numbers.tj).toBe('68781');
      expect(records[0]?.title_primary).toBe('アイドル');
      expect(
        captured.some(
          (call) =>
            call.body.strType === '16' &&
            call.body.strWord === 'Y' &&
            call.body.searchTxt === '68781',
        ),
      ).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('TJDirectCrawler.crawl — false-negative recovery (PR-2 promise)', () => {
  it('keeps a Latin-only-titled Japanese act via per-artist tagging when blog whitelist is empty', async () => {
    // PR-2 false-negative recovery: the per-artist scan must catch the
    // GRANRODEO-shaped case where the legacy regex would have dropped it.
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      const lastSeen = new Date().toISOString();
      const seeded = {
        version: 1,
        generatedAt: lastSeen,
        proEnrichmentMap: {},
        artistNationalityMap: {
          granrodeo: {
            code: 'JPN',
            votes: { JPN: 8, KOR: 0, ENG: 0 },
            lastSeen,
          },
        },
      };
      await writeFile(cachePath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

      const body = JSON.stringify({
        resultCode: '00',
        resultData: {
          itemsTotalCount: 1,
          items: [
            {
              pro: 11111,
              indexTitle: 'Trash Candy',
              indexSong: 'GRANRODEO',
              publishdate: '2016-01-27',
            },
          ],
        },
      });
      const http = buildHttp({ status: 200, body });
      const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, {
        disableEnrichment: true,
        cachePath,
      });
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);

      expect(records.length).toBe(1);
      expect(records[0]?.artist_primary).toBe('GRANRODEO');
      expect(records[0]?.karaoke_numbers.tj).toBe('11111');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('TJDirectCrawler.crawl — translit enrichment integration (PR-1)', () => {
  it('threads searchSong sortTitleKo/sortSongKo into emitted SongRecord and writes the cache', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'tj-search-cache.json');
    try {
      const catalogBody = JSON.stringify({
        resultCode: '99',
        resultData: {
          itemsTotalCount: 1,
          items: [
            {
              pro: 68781,
              indexTitle: 'アイドル',
              indexSong: 'YOASOBI',
              publishdate: '2023-05-24',
            },
          ],
        },
      });
      const searchBody = JSON.stringify({
        resultCode: '99',
        resultData: {
          itemsTotalCount: 1,
          items: [
            {
              pro: 68781,
              indexTitle: 'アイドル',
              indexSong: 'YOASOBI',
              sortTitleKo: '아이도루',
              sortSongKo: '요아소비',
              nationalcode: 'JPN',
              publishdate: '2023-05-24',
            },
          ],
        },
      });
      // Pre-seed the artist map so path-2 admits the record (avoids needing
      // to model the full bootstrap+scan + 67k-artist scan in a unit test).
      const lastSeen = new Date().toISOString();
      const seeded = {
        version: 1,
        generatedAt: lastSeen,
        proEnrichmentMap: {},
        artistNationalityMap: {
          yoasobi: {
            code: 'JPN',
            votes: { JPN: 5, KOR: 0, ENG: 0 },
            lastSeen,
          },
        },
      };
      await writeFile(cachePath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

      const http: Pick<HttpClient, 'postForm'> = {
        async postForm(url, _body): Promise<FetchResult | null> {
          if (url.includes('newSongOfMonth')) return { status: 200, body: catalogBody };
          if (url.includes('searchSong')) return { status: 200, body: searchBody };
          // The artist scan + bootstrap pass are best-effort here: their
          // calls land on this stub. We accept anything else as a 200 with
          // an empty result to keep the test focused on translit.
          if (url.includes('topAndHot100')) {
            return {
              status: 200,
              body: JSON.stringify({ resultCode: '99', resultData: { items: [] } }),
            };
          }
          throw new Error(`unexpected url: ${url}`);
        },
      };
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const crawler = new TJDirectCrawler(
          http as HttpClient,
          emptyWhitelist,
          { cachePath },
          emptySeed,
        );
        const records = [];
        for await (const r of crawler.crawl()) records.push(r);

        expect(records).toHaveLength(1);
        expect(records[0]?.title_ko).toBe('아이도루');
        expect(records[0]?.artist_ko).toBe('요아소비');
        expect(records[0]?.karaoke_numbers.tj).toBe('68781');

        const cacheText = await readFile(cachePath, 'utf8');
        const cache = JSON.parse(cacheText);
        expect(cache.proEnrichmentMap['68781']?.sortTitleKo).toBe('아이도루');
        expect(cache.proEnrichmentMap['68781']?.sortSongKo).toBe('요아소비');
      } finally {
        log.mockRestore();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('100% cache hit + fresh bootstrap + fresh artist tags: cache is NOT rewritten', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'tj-search-cache.json');
    try {
      const lastSeen = new Date().toISOString();
      const seeded = {
        version: 2,
        generatedAt: lastSeen,
        bootstrappedAt: lastSeen,
        proEnrichmentMap: {
          '68781': {
            nationalcode: 'JPN',
            sortTitleKo: '아이도루',
            sortSongKo: '요아소비',
            subTitle: null,
            publishdate: '2023-05-24',
            lastSeen,
          },
        },
        artistNationalityMap: {
          yoasobi: {
            code: 'JPN',
            votes: { JPN: 5, KOR: 0, ENG: 0 },
            lastSeen,
          },
        },
      };
      await writeFile(cachePath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');
      const before = await stat(cachePath);
      const beforeText = await readFile(cachePath, 'utf8');

      const catalogBody = JSON.stringify({
        resultCode: '99',
        resultData: {
          itemsTotalCount: 1,
          items: [
            {
              pro: 68781,
              indexTitle: 'アイドル',
              indexSong: 'YOASOBI',
              publishdate: '2023-05-24',
            },
          ],
        },
      });
      const http: Pick<HttpClient, 'postForm'> = {
        async postForm(url): Promise<FetchResult | null> {
          if (url.includes('newSongOfMonth')) return { status: 200, body: catalogBody };
          throw new Error(`unexpected url (no fetch should happen on warm cache): ${url}`);
        },
      };
      await new Promise((r) => setTimeout(r, 10));

      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const crawler = new TJDirectCrawler(
          http as HttpClient,
          emptyWhitelist,
          { cachePath },
          emptySeed,
        );
        const records = [];
        for await (const r of crawler.crawl()) records.push(r);

        expect(records).toHaveLength(1);
        expect(records[0]?.title_ko).toBe('아이도루');
        expect(records[0]?.artist_ko).toBe('요아소비');

        const after = await stat(cachePath);
        const afterText = await readFile(cachePath, 'utf8');
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(afterText).toBe(beforeText);
      } finally {
        log.mockRestore();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('searchSong HTTP error keeps the record with null title_ko/artist_ko (no regression)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-crawler-'));
    const cachePath = join(tmpDir, 'tj-search-cache.json');
    try {
      // Pre-seed so the parser admits the record (otherwise PR-2's filter
      // drops it before the translit pass even runs).
      const lastSeen = new Date().toISOString();
      const seeded = {
        version: 1,
        generatedAt: lastSeen,
        proEnrichmentMap: {},
        artistNationalityMap: {
          yoasobi: {
            code: 'JPN',
            votes: { JPN: 5, KOR: 0, ENG: 0 },
            lastSeen,
          },
        },
      };
      await writeFile(cachePath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

      const catalogBody = JSON.stringify({
        resultCode: '99',
        resultData: {
          itemsTotalCount: 1,
          items: [
            {
              pro: 68781,
              indexTitle: 'アイドル',
              indexSong: 'YOASOBI',
              publishdate: '2023-05-24',
            },
          ],
        },
      });
      const http: Pick<HttpClient, 'postForm'> = {
        async postForm(url): Promise<FetchResult | null> {
          if (url.includes('newSongOfMonth')) return { status: 200, body: catalogBody };
          if (url.includes('searchSong')) return { status: 503, body: 'oops' };
          if (url.includes('topAndHot100')) {
            return {
              status: 200,
              body: JSON.stringify({ resultCode: '99', resultData: { items: [] } }),
            };
          }
          throw new Error(`unexpected url: ${url}`);
        },
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const crawler = new TJDirectCrawler(
          http as HttpClient,
          emptyWhitelist,
          { cachePath },
          emptySeed,
        );
        const records = [];
        for await (const r of crawler.crawl()) records.push(r);

        expect(records).toHaveLength(1);
        expect(records[0]?.title_ko).toBeNull();
        expect(records[0]?.artist_ko).toBeNull();
      } finally {
        warn.mockRestore();
        log.mockRestore();
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('TJDirectCrawler.crawl — blog reverse-probe seed ingest', () => {
  // Cache tagging every fixture artist + pro as JPN with a FRESH bootstrap, so
  // the catalog admits its JP rows, the artist scan + chart bootstrap make no
  // HTTP calls, and — crucially — nothing that drops is a JP-likely rescue
  // candidate (Chinese/Korean drops carry no kana), so jpLikelyRescue issues
  // ZERO strType=16 probes. That isolates all strType=16 traffic to the SEED
  // probe under test.
  async function seedAllJpnFreshCache(cachePath: string): Promise<void> {
    const now = new Date().toISOString();
    const artistNationalityMap: Record<string, unknown> = {};
    const proEnrichmentMap: Record<string, unknown> = {};
    for (const item of FIXTURE.resultData.items) {
      if (typeof item.indexSong === 'string') {
        const key = item.indexSong.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
        if (key !== '') {
          artistNationalityMap[key] = {
            code: 'JPN',
            votes: { JPN: 1, KOR: 0, ENG: 0 },
            lastSeen: now,
          };
        }
      }
      proEnrichmentMap[String(item.pro)] = {
        nationalcode: 'JPN',
        sortTitleKo: null,
        sortSongKo: null,
        subTitle: null,
        publishdate: null,
        lastSeen: now,
      };
    }
    await writeFile(
      cachePath,
      `${JSON.stringify(
        {
          version: 2,
          generatedAt: now,
          bootstrappedAt: now,
          proEnrichmentMap,
          artistNationalityMap,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  it('empty seed issues zero probe calls (crawl byte-identical pin)', async () => {
    const captured: Captured[] = [];
    const http = buildHttp({
      captured,
      postFormImpl: async (url) => {
        if (url.includes('newSongOfMonth')) return { status: 200, body: FIXTURE_TEXT };
        // translit / artist / charts → benign empty search.
        return {
          status: 200,
          body: JSON.stringify({ resultCode: '98', resultData: { items: [] } }),
        };
      },
    });
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-seed-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      await seedAllJpnFreshCache(cachePath);
      const crawler = new TJDirectCrawler(
        http as HttpClient,
        emptyWhitelist,
        { cachePath },
        emptySeed,
      );
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);
      expect(records.length).toBeGreaterThan(0);
      // With an empty seed AND an all-JPN cache (rescue has no candidates),
      // NO exact-number (strType=16) probe is issued at all.
      expect(captured.some((c) => c.body.strType === '16')).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('probes a blog-claimed number this run did not emit and graduates the hit to a tj-* record', async () => {
    const SEED_PRO = '52784'; // not present in the fixture catalog
    const captured: Captured[] = [];
    const http = buildHttp({
      captured,
      postFormImpl: async (url, body) => {
        if (url.includes('newSongOfMonth')) return { status: 200, body: FIXTURE_TEXT };
        if (body.strType === '16' && body.searchTxt === SEED_PRO) {
          return {
            status: 200,
            body: JSON.stringify({
              resultCode: '99',
              resultData: {
                items: [
                  {
                    pro: SEED_PRO,
                    indexTitle: 'うつくしい世界',
                    indexSong: 'Aimer',
                    sortTitleKo: '',
                    sortSongKo: '',
                    nationalcode: 'JPN',
                    subTitle: '',
                    publishdate: '',
                  },
                ],
              },
            }),
          };
        }
        return {
          status: 200,
          body: JSON.stringify({ resultCode: '98', resultData: { items: [] } }),
        };
      },
    });
    const tmpDir = await mkdtemp(join(tmpdir(), 'tj-seed-'));
    const cachePath = join(tmpDir, 'cache.json');
    try {
      await seedAllJpnFreshCache(cachePath);
      const seed = (): ReadonlySet<string> => new Set([SEED_PRO]);
      const crawler = new TJDirectCrawler(http as HttpClient, emptyWhitelist, { cachePath }, seed);
      const records = [];
      for await (const r of crawler.crawl()) records.push(r);

      // The seed number was probed via the exact-number (strType=16) path…
      expect(captured.some((c) => c.body.strType === '16' && c.body.searchTxt === SEED_PRO)).toBe(
        true,
      );
      // …and the admitted hit graduated to a tj-* record in the crawl output.
      const graduated = records.find((r) => r.id === `tj-${SEED_PRO}`);
      expect(graduated).toBeDefined();
      expect(graduated?.title_primary).toBe('うつくしい世界');
      expect(graduated?.artist_primary).toBe('Aimer');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
