import { describe, expect, it } from 'vitest';
import {
  parseSearchSongResponse,
  searchSongByTitle,
} from '../../../src/adapters/tj-media-direct/searchSong.js';
import type { FetchResult, HttpClient } from '../../../src/http.js';

const SEARCH_SONG_URL = 'https://www.tjmedia.com/legacy/api/searchSong';

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
      return { status: opts.status ?? 200, body: opts.body ?? '{"resultCode":"99"}' };
    },
  };
}

describe('parseSearchSongResponse', () => {
  it('parses the flat strType=1 shape ({ items: [...] }) and maps fields', () => {
    const json = {
      resultCode: '99',
      resultMsg: '성공',
      resultData: {
        itemsTotalCount: 2,
        items: [
          {
            rownumber: 1,
            pro: 68781,
            indexTitle: 'アイドル(推しの子 OP)',
            subTitle: '',
            indexSong: 'YOASOBI',
            sortTitleKo: '아이도루(최애의 아이 OP)',
            sortSongKo: '',
            nationalcode: 'JPN',
            publishdate: '2023-05-24',
          },
          {
            rownumber: 2,
            pro: '11111',
            indexTitle: 'Title2',
            subTitle: 'sub',
            indexSong: 'Artist2',
            sortTitleKo: '',
            sortSongKo: '아티스트',
            nationalcode: '',
            publishdate: '',
          },
        ],
      },
    };
    const items = parseSearchSongResponse(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      pro: '68781',
      indexTitle: 'アイドル(推しの子 OP)',
      subTitle: null,
      indexSong: 'YOASOBI',
      sortTitleKo: '아이도루(최애의 아이 OP)',
      sortSongKo: null,
      nationalcode: 'JPN',
      publishdate: '2023-05-24',
    });
    expect(items[1]).toEqual({
      pro: '11111',
      indexTitle: 'Title2',
      subTitle: 'sub',
      indexSong: 'Artist2',
      sortTitleKo: null,
      sortSongKo: '아티스트',
      nationalcode: null,
      publishdate: null,
    });
  });

  it('parses the 6-bucket strType=0 shape and concatenates non-empty buckets', () => {
    // Mimics the live `strType=0` response: 6 wrapper objects, each holding
    // an `itemsN` array (some empty, some populated).
    const json = {
      resultCode: '99',
      resultData: [
        { items1TotalCount: 0, items1: [] },
        {
          items2TotalCount: 1,
          items2: [
            {
              pro: 1,
              indexTitle: 'A',
              indexSong: 'B',
              sortTitleKo: 'ㄱ',
              sortSongKo: 'ㄴ',
              nationalcode: 'JPN',
            },
          ],
        },
        { items3TotalCount: 0, items3: [] },
        {
          items4TotalCount: 2,
          items4: [
            {
              pro: 2,
              indexTitle: 'C',
              indexSong: 'D',
              sortTitleKo: '',
              sortSongKo: '',
              nationalcode: 'KOR',
            },
            {
              pro: 3,
              indexTitle: 'E',
              indexSong: 'F',
              sortTitleKo: '',
              sortSongKo: '',
              nationalcode: 'JPN',
            },
          ],
        },
        { items5TotalCount: 0, items5: [] },
        { items6TotalCount: 0, items6: [] },
      ],
    };
    const items = parseSearchSongResponse(json);
    expect(items.map((i) => i.pro)).toEqual(['1', '2', '3']);
    expect(items[0]?.nationalcode).toBe('JPN');
    expect(items[1]?.nationalcode).toBe('KOR');
  });

  it('returns [] for resultCode=98 (server-documented empty/no-data)', () => {
    const json = { resultCode: '98', resultMsg: '검색결과 없음', resultData: '' };
    expect(parseSearchSongResponse(json)).toEqual([]);
  });

  it('throws on resultCode!=99 and !=98 with the resultMsg in the message', () => {
    const json = { resultCode: '20', resultMsg: '필수 파라미터 누락' };
    expect(() => parseSearchSongResponse(json)).toThrow(/resultCode=20/);
    expect(() => parseSearchSongResponse(json)).toThrow(/필수 파라미터 누락/);
  });

  it('throws on a non-object response', () => {
    expect(() => parseSearchSongResponse(null)).toThrow(/not a JSON object/);
    expect(() => parseSearchSongResponse('string')).toThrow(/not a JSON object/);
    expect(() => parseSearchSongResponse(42)).toThrow(/not a JSON object/);
  });

  it('skips items missing pro / indexTitle / indexSong', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          { pro: 1, indexTitle: 'A', indexSong: 'B', nationalcode: 'JPN' },
          { pro: null, indexTitle: 'A', indexSong: 'B' },
          { pro: 2, indexTitle: '', indexSong: 'B' },
          { pro: 3, indexTitle: 'A', indexSong: '' },
        ],
      },
    };
    const items = parseSearchSongResponse(json);
    expect(items).toHaveLength(1);
    expect(items[0]?.pro).toBe('1');
  });

  it('coerces empty-string fields to null', () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 1,
            indexTitle: 'A',
            indexSong: 'B',
            subTitle: '',
            sortTitleKo: '',
            sortSongKo: '',
            nationalcode: '',
            publishdate: '',
          },
        ],
      },
    };
    const items = parseSearchSongResponse(json);
    expect(items[0]?.subTitle).toBeNull();
    expect(items[0]?.sortTitleKo).toBeNull();
    expect(items[0]?.sortSongKo).toBeNull();
    expect(items[0]?.nationalcode).toBeNull();
    expect(items[0]?.publishdate).toBeNull();
  });
});

describe('searchSongByTitle', () => {
  it('issues a single POST with strType=1 + nationType=JPN by default', async () => {
    const captured: Captured[] = [];
    const http = buildHttp({
      captured,
      body: JSON.stringify({ resultCode: '99', resultData: { items: [] } }),
    });
    const items = await searchSongByTitle(http, 'アイドル');
    expect(items).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(SEARCH_SONG_URL);
    expect(captured[0]?.body).toEqual({
      searchTxt: 'アイドル',
      strType: '1',
      nationType: 'JPN',
    });
  });

  it('accepts overrides for nationType and strType', async () => {
    const captured: Captured[] = [];
    const http = buildHttp({
      captured,
      body: JSON.stringify({ resultCode: '99', resultData: { items: [] } }),
    });
    await searchSongByTitle(http, 'q', '', 0);
    expect(captured[0]?.body).toEqual({ searchTxt: 'q', strType: '0', nationType: '' });
  });

  it('short-circuits on empty searchTxt without an HTTP call', async () => {
    const captured: Captured[] = [];
    const http = buildHttp({ captured });
    expect(await searchSongByTitle(http, '')).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('throws on non-2xx status', async () => {
    const http = buildHttp({ status: 503, body: '<html>oops</html>' });
    await expect(searchSongByTitle(http, 'q')).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the body is not valid JSON', async () => {
    const http = buildHttp({ status: 200, body: 'not json {{{' });
    await expect(searchSongByTitle(http, 'q')).rejects.toThrow(/not valid JSON/);
  });

  it('throws when robots.txt blocks the URL (postForm returns null)', async () => {
    const http = buildHttp({ postFormImpl: async () => null });
    await expect(searchSongByTitle(http, 'q')).rejects.toThrow(/robots\.txt/);
  });

  it('returns parsed items on the happy path', async () => {
    const json = {
      resultCode: '99',
      resultData: {
        items: [
          {
            pro: 68781,
            indexTitle: 'アイドル',
            indexSong: 'YOASOBI',
            sortTitleKo: '아이도루',
            sortSongKo: '',
            nationalcode: 'JPN',
            publishdate: '2023-05-24',
          },
        ],
      },
    };
    const http = buildHttp({ status: 200, body: JSON.stringify(json) });
    const items = await searchSongByTitle(http, 'アイドル');
    expect(items).toHaveLength(1);
    expect(items[0]?.pro).toBe('68781');
    expect(items[0]?.sortTitleKo).toBe('아이도루');
    expect(items[0]?.sortSongKo).toBeNull();
  });
});
