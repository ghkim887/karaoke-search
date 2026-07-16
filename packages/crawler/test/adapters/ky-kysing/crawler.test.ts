import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KY_KARAOKE_BOOK_INDEX, KyKysingCrawler } from '../../../src/adapters/ky-kysing/crawler.js';
import type { HttpClient } from '../../../src/http.js';

interface FakeRow {
  ky: string;
  title: string;
  artist: string;
}

function indexRow(r: FakeRow): string {
  return `<ul class="index_search_list"><li class="index_search_num">${r.ky}</li><li class="index_search_tit" title="${r.title}">${r.title}</li><li class="index_search_sng" title="${r.artist}">${r.artist}</li></ul>`;
}

function indexHtml(rows: FakeRow[]): string {
  return `<!doctype html><html><body>${rows.map(indexRow).join('')}</body></html>`;
}

function detailHtml(r: FakeRow): string {
  const header =
    '<ul class="search_chart_list"><li class="search_chart_num">곡번호</li><li class="search_chart_tit">곡명</li><li class="search_chart_sng">아티스트</li></ul>';
  const data = `<ul class="search_chart_list"><li class="search_chart_num">${r.ky}</li><li class="search_chart_tit clear"><span title="${r.title}" class="tit">${r.title}</span><span title="${r.artist}" class="tit mo-art">${r.artist}</span></li><li class="search_chart_sng" title="${r.artist}">${r.artist}</li></ul>`;
  return `<!doctype html><html><body>${header}${data}</body></html>`;
}

/**
 * Build a fake HttpClient. `pages` maps `${s_value}:${s_page}` to index rows
 * (a page absent from the map returns 0 rows → walk ends). `details` maps a KY
 * number to the detail row served by the `category=1` page.
 */
function fakeHttp(opts: {
  pages: Record<string, FakeRow[]>;
  details?: Record<string, FakeRow>;
  detailStatus?: Record<string, number>;
}): { http: Pick<HttpClient, 'fetch'>; fetched: string[] } {
  const fetched: string[] = [];
  const http: Pick<HttpClient, 'fetch'> = {
    async fetch(url: string) {
      fetched.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.startsWith('/karaoke-book')) {
        const sv = parsed.searchParams.get('s_value') ?? '';
        const sp = parsed.searchParams.get('s_page') ?? '1';
        return { status: 200, body: indexHtml(opts.pages[`${sv}:${sp}`] ?? []) };
      }
      if (parsed.pathname.startsWith('/search')) {
        const kw = parsed.searchParams.get('keyword') ?? '';
        const st = opts.detailStatus?.[kw];
        if (st !== undefined && st !== 200) return { status: st, body: '' };
        const row = opts.details?.[kw];
        if (!row) return { status: 200, body: '<html><body></body></html>' };
        return { status: 200, body: detailHtml(row) };
      }
      return { status: 404, body: '' };
    },
  };
  return { http, fetched };
}

describe('KY_KARAOKE_BOOK_INDEX', () => {
  it('is the 107 distinct live jp index values (hiragana + 0 + A-Z)', () => {
    expect(KY_KARAOKE_BOOK_INDEX).toHaveLength(107);
    expect(new Set(KY_KARAOKE_BOOK_INDEX).size).toBe(107);
    expect(KY_KARAOKE_BOOK_INDEX).toContain('あ');
    expect(KY_KARAOKE_BOOK_INDEX).toContain('0'); // 其他 / ETC bucket
    expect(KY_KARAOKE_BOOK_INDEX).toContain('Z');
  });
});

describe('KyKysingCrawler — index walk', () => {
  afterEach(() => vi.restoreAllMocks());

  it('yields admitted rows, walks page 1..empty, and stops per letter', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http, fetched } = fakeHttp({
      pages: {
        'あ:1': [
          { ky: '44655', title: '怪物', artist: 'YOASOBI' },
          { ky: '75951', title: '#君と僕とが出逢った日', artist: '舟津真翔' },
        ],
        // 'あ:2' absent → empty → walk ends for the letter
      },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl()) recs.push(r);

    expect(recs.map((r) => r.id)).toEqual(['ky-44655', 'ky-75951']);
    expect(recs[0]?.karaoke_numbers).toEqual({ tj: null, ky: '44655', joysound: null });
    // page 1 then page 2 (empty) fetched; no page 3.
    expect(fetched.some((u) => u.includes('s_page=1'))).toBe(true);
    expect(fetched.some((u) => u.includes('s_page=2'))).toBe(true);
    expect(fetched.some((u) => u.includes('s_page=3'))).toBe(false);
  });

  it('dedupes by KY number across pages', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttp({
      pages: {
        'あ:1': [{ ky: '44655', title: '怪物', artist: 'YOASOBI' }],
        'あ:2': [{ ky: '44655', title: '怪物', artist: 'YOASOBI' }], // dup
      },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl()) recs.push(r);
    expect(recs.map((r) => r.id)).toEqual(['ky-44655']);
  });

  it('honors the yield limit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttp({
      pages: {
        'あ:1': [
          { ky: '1', title: '怪物', artist: 'YOASOBI' },
          { ky: '2', title: 'Lemon', artist: '米津玄師' },
          { ky: '3', title: '群青', artist: 'YOASOBI' },
        ],
      },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl({ limit: 2 })) recs.push(r);
    expect(recs.map((r) => r.id)).toEqual(['ky-1', 'ky-2']);
  });

  it('drops a Korean-script row (not yielded)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttp({
      pages: {
        'あ:1': [
          { ky: '10', title: '怪物', artist: 'YOASOBI' },
          { ky: '11', title: '봄날', artist: '가나다라마' }, // Korean-script
        ],
      },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl()) recs.push(r);
    expect(recs.map((r) => r.id)).toEqual(['ky-10']);
  });
});

describe('KyKysingCrawler — truncation repair', () => {
  afterEach(() => vi.restoreAllMocks());

  it('repairs a truncated index row from the detail page (admit-detail-repaired)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http, fetched } = fakeHttp({
      pages: {
        'あ:1': [{ ky: '500', title: 'あの素晴らしい愛を(オリジナ..', artist: 'ある歌手' }],
      },
      details: {
        '500': { ky: '500', title: 'あの素晴らしい愛をもう一度', artist: 'ある歌手' },
      },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl()) recs.push(r);

    expect(recs).toHaveLength(1);
    expect(recs[0]?.title_primary).toBe('あの素晴らしい愛をもう一度'); // repaired, full
    // The detail page was fetched for the truncated row.
    expect(fetched.some((u) => u.includes('/search') && u.includes('keyword=500'))).toBe(true);
  });

  it('drops a truncated row when the detail is ALSO truncated (repair failure)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttp({
      pages: {
        'あ:1': [{ ky: '501', title: '長い長いタイトル(補足情報がここに..', artist: 'ある歌手' }],
      },
      details: {
        '501': { ky: '501', title: '長い長いタイトル(補足情報がここに..', artist: 'ある歌手' },
      },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl()) recs.push(r);
    expect(recs).toHaveLength(0);
  });

  it('drops a truncated row when the detail fetch is non-2xx', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttp({
      pages: { 'あ:1': [{ ky: '502', title: 'タイトルが切れている..', artist: 'ある歌手' }] },
      detailStatus: { '502': 500 },
    });
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl()) recs.push(r);
    expect(recs).toHaveLength(0);
  });
});

describe('KyKysingCrawler — failure semantics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws when an index page is blocked by robots (null fetch)', async () => {
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch() {
        return null;
      },
    };
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/robots/);
  });

  it('throws when an index page returns non-2xx', async () => {
    const http: Pick<HttpClient, 'fetch'> = {
      async fetch() {
        return { status: 503, body: '' };
      },
    };
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    await expect(async () => {
      for await (const _ of crawler.crawl()) {
        /* unreachable */
      }
    }).rejects.toThrow(/503/);
  });
});

describe('KyKysingCrawler — decision log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes a JSONL decision row for every classified row (admit + drop)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { http } = fakeHttp({
      pages: {
        'あ:1': [
          { ky: '20', title: '怪物', artist: 'YOASOBI' }, // admit-index
          { ky: '21', title: 'Dynamite', artist: 'BTS' }, // drop-korean-artist
        ],
      },
    });
    const dir = await mkdtemp(join(tmpdir(), 'ky-decisions-'));
    const outPath = join(dir, 'ky-filter.jsonl');
    const crawler = new KyKysingCrawler(http as HttpClient, { indexValues: ['あ'] });
    const recs = [];
    for await (const r of crawler.crawl({ kyDecisionsOutPath: outPath })) recs.push(r);

    const lines = (await readFile(outPath, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        ky: '20',
        title: '怪物',
        artist: 'YOASOBI',
        decision: 'admit',
        step: 'index',
        reason: 'admit-index',
      },
      {
        ky: '21',
        title: 'Dynamite',
        artist: 'BTS',
        decision: 'drop',
        step: 'drop-list',
        reason: 'drop-korean-artist',
      },
    ]);
    expect(recs.map((r) => r.id)).toEqual(['ky-20']);
  });
});
