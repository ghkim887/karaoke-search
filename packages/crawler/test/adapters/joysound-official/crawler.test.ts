import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JoysoundFullCatalogCrawler,
  JoysoundOfficialCrawler,
} from '../../../src/adapters/joysound-official/crawler.js';
import type { HttpClient } from '../../../src/http.js';

// Zero-delay backoff so retry tests don't actually sleep.
const NO_BACKOFF = { detailRetryBackoffMs: 0 } as const;

const LISTING_BASE = 'https://www.joysound.com/web/karaoke/contents/new';
const FULL_SONGLIST_BASE = 'https://www.joysound.com/web/search/songlist';
const DETAIL_BASE = 'https://www.joysound.com/apis/v1/ise/fetchContentsDetail';

interface FakeItem {
  naviGroupId: string;
  selSongNo: string;
  songName: string;
  artistName: string;
  tieupInfo?: string | null;
  songNameRuby?: string | null;
  detailNaviGroupId?: string | null;
  detailSelSongNo?: string | null;
}

function listingHtml(items: FakeItem[], totalPages: number): string {
  // The RSC parser scans for `"naviGroupId":...` objects in either an
  // escaped __next_f.push chunk OR an inline JSON blob. We emit inline JSON
  // since the parser falls back to the raw body when no push calls match —
  // simpler to set up and exercises the same extractor.
  const itemJson = items
    .map((it) => {
      const tieup =
        it.tieupInfo === undefined || it.tieupInfo === null
          ? '"$undefined"'
          : JSON.stringify(it.tieupInfo);
      return `{"naviGroupId":"${it.naviGroupId}","selSongNo":"${it.selSongNo}","songName":${JSON.stringify(it.songName)},"artistName":${JSON.stringify(it.artistName)},"artistId":"$undefined","tieupInfo":${tieup},"tieupId":"$undefined"}`;
    })
    .join(',');
  return `<!doctype html><html><body><script>{"totalPages":${totalPages},"items":[${itemJson}]}</script></body></html>`;
}

function detailJson(it: FakeItem): string {
  return JSON.stringify({
    naviGroupId: it.detailNaviGroupId ?? it.naviGroupId,
    selSongNo: it.detailSelSongNo ?? it.selSongNo,
    songName: it.songName,
    songNameRuby: it.songNameRuby ?? null,
    artistName: it.artistName,
    artistId: null,
    songId: null,
    lyricist: null,
    composer: null,
    relDate: null,
    newFlg: null,
    lyricIntro: null,
    genreList: [],
    tieupList: it.tieupInfo ? [{ name: it.tieupInfo }] : [],
    aplList: [],
  });
}

interface FakeFetchOptions {
  page1Items: FakeItem[];
  page2Items?: FakeItem[];
  totalPages?: number;
}

function fakeHttpFor(opts: FakeFetchOptions): {
  http: Pick<HttpClient, 'fetch'>;
  fetched: string[];
} {
  const fetched: string[] = [];
  const allItems = [...opts.page1Items, ...(opts.page2Items ?? [])];
  const itemById = new Map<string, FakeItem>(allItems.map((it) => [it.naviGroupId, it]));
  const http: Pick<HttpClient, 'fetch'> = {
    async fetch(url: string) {
      fetched.push(url);
      const parsed = new URL(url);
      if (
        parsed.origin === 'https://www.joysound.com' &&
        parsed.pathname.startsWith('/web/karaoke/contents/new')
      ) {
        const page = parsed.searchParams.get('page') ?? '1';
        const items = page === '1' ? opts.page1Items : (opts.page2Items ?? []);
        return { status: 200, body: listingHtml(items, opts.totalPages ?? 1) };
      }
      if (
        parsed.origin === 'https://www.joysound.com' &&
        parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')
      ) {
        const id = parsed.searchParams.get('id') ?? '';
        const it = itemById.get(id);
        if (!it) return { status: 404, body: '' };
        return { status: 200, body: detailJson(it) };
      }
      return { status: 404, body: '' };
    },
  };
  return { http, fetched };
}

describe('JoysoundOfficialCrawler — listing → detail → classify → normalize', () => {
  it('yields one record from a single JP item on page 1 (limit=1)', async () => {
    const { http, fetched } = fakeHttpFor({
      page1Items: [
        {
          naviGroupId: '190001',
          selSongNo: '190-001',
          songName: '夜に駆ける',
          artistName: 'YOASOBI',
        },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-190001');
    expect(recs[0]?.karaoke_numbers.joysound).toBe('190001');
    expect(recs[0]?.title_ko).toBeNull();
    expect(recs[0]?.artist_ko).toBeNull();

    // One listing fetch + one detail fetch.
    expect(fetched).toContain(`${LISTING_BASE}?page=1`);
    expect(fetched.some((u) => u.startsWith(`${DETAIL_BASE}?`) && u.includes('id=190001'))).toBe(
      true,
    );
  });

  it('drops K-pop rows like aespa/ENHYPEN and yields the next eligible item', async () => {
    const { http } = fakeHttpFor({
      page1Items: [
        {
          naviGroupId: '500001',
          selSongNo: '500-001',
          songName: 'Set The Tone',
          artistName: 'aespa',
        },
        {
          naviGroupId: '500002',
          selSongNo: '500-002',
          songName: 'Chaconne',
          artistName: 'ENHYPEN',
        },
        {
          naviGroupId: '500003',
          selSongNo: '500-003',
          songName: '紅蓮華',
          artistName: 'LiSA',
          tieupInfo: 'TVアニメ「鬼滅の刃」OP',
        },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-500003');
  });

  it('honors a multi-record limit and stops fetching details once limit is hit', async () => {
    const { http, fetched } = fakeHttpFor({
      page1Items: [
        {
          naviGroupId: '600001',
          selSongNo: '600-001',
          songName: 'よるにかける',
          artistName: 'YOASOBI',
        },
        { naviGroupId: '600002', selSongNo: '600-002', songName: '千本桜', artistName: '初音ミク' },
        {
          naviGroupId: '600003',
          selSongNo: '600-003',
          songName: '紅蓮華',
          artistName: 'LiSA',
          tieupInfo: 'TVアニメ「鬼滅の刃」OP',
        },
        { naviGroupId: '600004', selSongNo: '600-004', songName: 'Lemon', artistName: '米津玄師' },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 2 })) recs.push(r);

    expect(recs).toHaveLength(2);
    expect(recs[0]?.id).toBe('joysound-600001');
    expect(recs[1]?.id).toBe('joysound-600002');
    // No detail fetch for items 3 / 4 (limit stopped early).
    expect(fetched.some((u) => u.includes('id=600003'))).toBe(false);
    expect(fetched.some((u) => u.includes('id=600004'))).toBe(false);
  });

  it('walks to page 2 when page 1 cannot fill the limit', async () => {
    const { http, fetched } = fakeHttpFor({
      page1Items: [
        // All K-pop drops on page 1.
        {
          naviGroupId: '700001',
          selSongNo: '700-001',
          songName: 'Set The Tone',
          artistName: 'aespa',
        },
        {
          naviGroupId: '700002',
          selSongNo: '700-002',
          songName: 'Chaconne',
          artistName: 'ENHYPEN',
        },
      ],
      page2Items: [
        {
          naviGroupId: '700003',
          selSongNo: '700-003',
          songName: '紅蓮華',
          artistName: 'LiSA',
          tieupInfo: 'TVアニメ「鬼滅の刃」OP',
        },
      ],
      totalPages: 2,
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-700003');
    expect(fetched).toContain(`${LISTING_BASE}?page=1`);
    expect(fetched).toContain(`${LISTING_BASE}?page=2`);
  });

  it('full-catalog crawler walks kana-indexed songlist pages in order', async () => {
    const fetched: string[] = [];
    const itemsByKanaPage = new Map<string, FakeItem[]>([
      [
        'ア:1',
        [
          {
            naviGroupId: '930001',
            selSongNo: '930-001',
            songName: 'Set The Tone',
            artistName: 'aespa',
          },
        ],
      ],
      ['ア:2', []],
      [
        'カ:1',
        [
          {
            naviGroupId: '930002',
            selSongNo: '930-002',
            songName: '君の知らない物語',
            artistName: 'supercell',
            tieupInfo: 'TVアニメ「化物語」テーマソング',
          },
        ],
      ],
    ]);
    const itemById = new Map<string, FakeItem>(
      [...itemsByKanaPage.values()].flat().map((it) => [it.naviGroupId, it]),
    );
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        fetched.push(url);
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/search/songlist/')) {
          const kana = decodeURIComponent(parsed.pathname.split('/').at(-1) ?? '');
          const page = parsed.searchParams.get('page') ?? '1';
          const totalPages = kana === 'ア' ? 2 : 1;
          return {
            status: 200,
            body: listingHtml(itemsByKanaPage.get(`${kana}:${page}`) ?? [], totalPages),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          const id = parsed.searchParams.get('id') ?? '';
          const it = itemById.get(id);
          if (!it) return { status: 404, body: '' };
          return { status: 200, body: detailJson(it) };
        }
        return { status: 404, body: '' };
      },
    };

    const crawler = new JoysoundFullCatalogCrawler(http as HttpClient, { kana: ['ア', 'カ'] });
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(crawler.name).toBe('joysound-official-full-catalog');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-930002');
    expect(fetched).toContain(`${FULL_SONGLIST_BASE}/${encodeURIComponent('ア')}?page=1`);
    expect(fetched).toContain(`${FULL_SONGLIST_BASE}/${encodeURIComponent('ア')}?page=2`);
    expect(fetched).toContain(`${FULL_SONGLIST_BASE}/${encodeURIComponent('カ')}?page=1`);
    expect(fetched).toContain(`${DETAIL_BASE}?kind=naviGroupId&id=930001`);
    expect(fetched).toContain(`${DETAIL_BASE}?kind=naviGroupId&id=930002`);
  });

  it('source_url is the JOYSOUND song page for naviGroupId', async () => {
    const { http } = fakeHttpFor({
      page1Items: [
        {
          naviGroupId: '800001',
          selSongNo: '800-001',
          songName: '夜に駆ける',
          artistName: 'YOASOBI',
        },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);
    expect(recs[0]?.source_url).toMatch(/joysound\.com.*800001/);
  });

  it('throws when the listing page is blocked by robots (null fetch result)', async () => {
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch() {
        return null;
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    await expect(async () => {
      for await (const _ of crawler.crawl({ limit: 1 })) {
        // unreachable
      }
    }).rejects.toThrow(/robots/);
  });

  it('throws when the listing page returns non-2xx', async () => {
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch() {
        return { status: 503, body: 'unavailable' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    await expect(async () => {
      for await (const _ of crawler.crawl({ limit: 1 })) {
        // unreachable
      }
    }).rejects.toThrow(/503/);
  });

  it('skips a record when its detail fetch returns non-2xx, then yields the next eligible item', async () => {
    let detailCallCount = 0;
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                {
                  naviGroupId: '900001',
                  selSongNo: '900-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
                {
                  naviGroupId: '900002',
                  selSongNo: '900-002',
                  songName: '千本桜',
                  artistName: '初音ミク',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          detailCallCount++;
          if (detailCallCount === 1) return { status: 500, body: '' };
          const id = parsed.searchParams.get('id') ?? '';
          return {
            status: 200,
            body: detailJson({
              naviGroupId: id,
              selSongNo: '900-002',
              songName: '千本桜',
              artistName: '初音ミク',
            }),
          };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);
    // The 1st detail fetch failed; the 2nd should be the one that yields.
    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-900002');
  });

  it('skips a record when detail.naviGroupId does not match the listing item', async () => {
    const { http } = fakeHttpFor({
      page1Items: [
        {
          naviGroupId: '910001',
          detailNaviGroupId: '910999',
          selSongNo: '910-001',
          songName: '夜に駆ける',
          artistName: 'YOASOBI',
        },
        {
          naviGroupId: '910002',
          selSongNo: '910-002',
          songName: '千本桜',
          artistName: '初音ミク',
        },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-910002');
  });

  it('skips a record when detail.selSongNo does not match the listing item', async () => {
    const { http } = fakeHttpFor({
      page1Items: [
        {
          naviGroupId: '920001',
          selSongNo: '920-001',
          detailSelSongNo: '920-999',
          songName: '夜に駆ける',
          artistName: 'YOASOBI',
        },
        {
          naviGroupId: '920002',
          selSongNo: '920-002',
          songName: '千本桜',
          artistName: '初音ミク',
        },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-920002');
  });
});

describe('JoysoundOfficialCrawler — detail-fetch resilience (retry + skip count)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a 429 detail response once and yields the record on the 200 retry', async () => {
    let detailCallCount = 0;
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                {
                  naviGroupId: '940001',
                  selSongNo: '940-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          detailCallCount++;
          // First attempt 429, retry succeeds.
          if (detailCallCount === 1) return { status: 429, body: '' };
          const id = parsed.searchParams.get('id') ?? '';
          return {
            status: 200,
            body: detailJson({
              naviGroupId: id,
              selSongNo: '940-001',
              songName: '夜に駆ける',
              artistName: 'YOASOBI',
            }),
          };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(detailCallCount).toBe(2); // initial 429 + one retry
    expect(recs).toHaveLength(1);
    expect(recs[0]?.id).toBe('joysound-940001');
  });

  it('retries a 503 detail response once and yields on the 200 retry', async () => {
    let detailCallCount = 0;
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                {
                  naviGroupId: '950001',
                  selSongNo: '950-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          detailCallCount++;
          if (detailCallCount === 1) return { status: 503, body: '' };
          const id = parsed.searchParams.get('id') ?? '';
          return {
            status: 200,
            body: detailJson({
              naviGroupId: id,
              selSongNo: '950-001',
              songName: '夜に駆ける',
              artistName: 'YOASOBI',
            }),
          };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(detailCallCount).toBe(2);
    expect(recs).toHaveLength(1);
  });

  it('does NOT retry a 404 detail response (only 429/5xx retry)', async () => {
    let detailCallCount = 0;
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                {
                  naviGroupId: '960001',
                  selSongNo: '960-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          detailCallCount++;
          return { status: 404, body: '' };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 1 })) recs.push(r);

    expect(detailCallCount).toBe(1); // 4xx (non-429) is not retried
    expect(recs).toHaveLength(0);
  });

  it('increments the skip counter and logs a run summary when detail keeps failing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                {
                  naviGroupId: '970001',
                  selSongNo: '970-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
                {
                  naviGroupId: '970002',
                  selSongNo: '970-002',
                  songName: '千本桜',
                  artistName: '初音ミク',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          // Always 500, even on retry → both rows skipped.
          return { status: 500, body: '' };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 0 })) recs.push(r);

    expect(recs).toHaveLength(0);
    // The run summary surfaces the skip count (not buried in warns).
    const summaryLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes('joysound-official') && /skip/i.test(line));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/skipped\D*2/);
    // The summary attributes the skips to detail-fetch failures, accurately.
    expect(summaryLine).toMatch(/2\s+detail-fetch/);
  });

  it('skips a row whose detail body is unparseable, counts it as detail-fetch, and continues', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                // First row: detail body is present (HTTP 200) but malformed
                // JSON → JSON.parse throws → row skipped at the parse step.
                {
                  naviGroupId: '990001',
                  selSongNo: '990-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
                // Clean follow-on row that must still be yielded.
                {
                  naviGroupId: '990002',
                  selSongNo: '990-002',
                  songName: '千本桜',
                  artistName: '初音ミク',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          const id = parsed.searchParams.get('id') ?? '';
          if (id === '990001') {
            // HTTP 200 but the body is not valid JSON → parse failure.
            return { status: 200, body: '{not valid json' };
          }
          return {
            status: 200,
            body: detailJson({
              naviGroupId: id,
              selSongNo: '990-002',
              songName: '千本桜',
              artistName: '初音ミク',
            }),
          };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 0 })) recs.push(r);

    // The crawl continues past the parse failure and yields the clean row.
    expect(recs.map((r) => r.id)).toEqual(['joysound-990002']);
    expect(recs.some((r) => r.id === 'joysound-990001')).toBe(false);

    // The run summary must count the parse failure (not vanish from the total).
    const summaryLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes('joysound-official') && /skip/i.test(line));
    expect(summaryLine).toBeDefined();
    // Exactly one skip, attributed to the detail-fetch bucket, none invalid.
    expect(summaryLine).toMatch(/skipped\D*1/);
    expect(summaryLine).toMatch(/1\s+detail-fetch/);
    expect(summaryLine).toMatch(/0\s+invalid/);
  });

  it('skips a row whose detail body parses as JSON but fails structural validation, counted as detail-fetch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch(url: string) {
        const parsed = new URL(url);
        if (parsed.pathname.startsWith('/web/karaoke/contents/new')) {
          return {
            status: 200,
            body: listingHtml(
              [
                {
                  naviGroupId: '991001',
                  selSongNo: '991-001',
                  songName: '夜に駆ける',
                  artistName: 'YOASOBI',
                },
                {
                  naviGroupId: '991002',
                  selSongNo: '991-002',
                  songName: '千本桜',
                  artistName: '初音ミク',
                },
              ],
              1,
            ),
          };
        }
        if (parsed.pathname.startsWith('/apis/v1/ise/fetchContentsDetail')) {
          const id = parsed.searchParams.get('id') ?? '';
          if (id === '991001') {
            // Valid JSON but the expected structure is missing (no required
            // naviGroupId) → parseJoysoundDetail throws.
            return { status: 200, body: JSON.stringify({ unexpected: 'shape' }) };
          }
          return {
            status: 200,
            body: detailJson({
              naviGroupId: id,
              selSongNo: '991-002',
              songName: '千本桜',
              artistName: '初音ミク',
            }),
          };
        }
        return { status: 404, body: '' };
      },
    };
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 0 })) recs.push(r);

    expect(recs.map((r) => r.id)).toEqual(['joysound-991002']);

    const summaryLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes('joysound-official') && /skip/i.test(line));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/skipped\D*1/);
    expect(summaryLine).toMatch(/1\s+detail-fetch/);
    expect(summaryLine).toMatch(/0\s+invalid/);
  });

  it('skips a row whose selSongNo normalizes to invalid without aborting the crawl, and counts it as invalid', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttpFor({
      page1Items: [
        // selSongNo carries a stray letter → dashless form '190001A' is not
        // digits → normalizeJoysoundNumber throws. Detail echoes the same
        // value so detailMatchesListing passes and we reach the normalizer.
        {
          naviGroupId: '980001',
          selSongNo: '190-001A',
          songName: '夜に駆ける',
          artistName: 'YOASOBI',
        },
        // A clean follow-on row that must still be yielded.
        {
          naviGroupId: '980002',
          selSongNo: '980-002',
          songName: '千本桜',
          artistName: '初音ミク',
        },
      ],
    });
    const crawler = new JoysoundOfficialCrawler(http as HttpClient, NO_BACKOFF);
    const recs = [];
    for await (const r of crawler.crawl({ limit: 0 })) recs.push(r);

    // The crawl completes (does not throw) and the malformed row is absent.
    expect(recs.map((r) => r.id)).toEqual(['joysound-980002']);
    expect(recs.some((r) => r.id === 'joysound-980001')).toBe(false);

    // The run summary surfaces the invalid-row skip count accurately.
    const summaryLine = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes('joysound-official') && /skip/i.test(line));
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/1\s+invalid/);
  });
});
