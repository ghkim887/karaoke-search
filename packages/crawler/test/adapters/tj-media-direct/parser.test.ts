import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHINESE_ARTIST_DENYLIST,
  parseCatalogResponse,
} from '../../../src/adapters/tj-media-direct/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/catalog-sample.json');
const SOURCE_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('parseCatalogResponse — catalog-sample.json fixture', () => {
  const records = parseCatalogResponse(FIXTURE, SOURCE_URL);

  it('extracts JP-relevant records and excludes Korean / Latin-only / denylist items', () => {
    // Hand-built fixture: 31 JP-relevant + 10 Korean + 10 English-only.
    // One of the Han-only records (pro=90015, 海来阿木) is now in the
    // Chinese-artist denylist, so the JP-relevant subset drops to 30.
    expect(records.length).toBe(30);
  });

  it('maps the YOASOBI アイドル record (pro=68781) per the field-map contract', () => {
    const idol = records.find((r) => r.karaoke_numbers.tj === '68781');
    expect(idol).toBeDefined();
    expect(idol?.title_primary).toBe('アイドル(推しの子 OP)');
    expect(idol?.artist_primary).toBe('YOASOBI');
    expect(idol?.title_ko).toBeNull();
    expect(idol?.artist_ko).toBeNull();
    expect(idol?.karaoke_numbers.ky).toBeNull();
    expect(idol?.karaoke_numbers.joysound).toBeNull();
    expect(idol?.categories).toEqual(['jpop']);
    expect(idol?.source_url).toBe(SOURCE_URL);
  });

  it('every parsed tj is digits-only', () => {
    for (const r of records) {
      const tj = r.karaoke_numbers.tj;
      expect(tj).not.toBeNull();
      expect(tj).toMatch(/^\d+$/);
    }
  });

  it('every record carries the source_url passed in', () => {
    for (const r of records) {
      expect(r.source_url).toBe(SOURCE_URL);
    }
  });

  it('every record has Korean fields null and categories=["jpop"]', () => {
    for (const r of records) {
      expect(r.title_ko).toBeNull();
      expect(r.artist_ko).toBeNull();
      expect(r.karaoke_numbers.ky).toBeNull();
      expect(r.karaoke_numbers.joysound).toBeNull();
      expect(r.categories).toEqual(['jpop']);
    }
  });

  it('excludes Hangul-containing records (Korean leak control)', () => {
    // The fixture includes 10 Korean items; none should appear in the output.
    for (const r of records) {
      expect(r.title_primary + r.artist_primary).not.toMatch(/[가-힯]/);
    }
  });

  it('excludes Latin-only records (English leak control)', () => {
    // No record should be both Latin-only in title AND Latin-only in artist.
    for (const r of records) {
      const t = r.title_primary;
      const a = r.artist_primary;
      const titleHasJp = /[぀-ゟ゠-ヿ一-鿿]/.test(t);
      const artistHasJp = /[぀-ゟ゠-ヿ一-鿿]/.test(a);
      expect(titleHasJp || artistHasJp).toBe(true);
    }
  });

  it('excludes a denylisted Chinese artist (pro=90015 海来阿木)', () => {
    // Pre-refinement this was the documented Chinese-leak case. With the
    // denylist, this record must be dropped.
    const denied = records.find((r) => r.karaoke_numbers.tj === '90015');
    expect(denied).toBeUndefined();
  });

  it('still includes Han-only records by artists NOT in the denylist (e.g. pro=90014 洋澜一)', () => {
    // The denylist is targeted, not blanket — long-tail Han-only artists not
    // in the seed list still pass through. Documents accepted scope.
    const leak = records.find((r) => r.karaoke_numbers.tj === '90014');
    expect(leak).toBeDefined();
    expect(leak?.artist_primary).toBe('洋澜一');
  });
});

describe('parseCatalogResponse — Chinese-artist denylist (refinement 1)', () => {
  it('drops a record whose artist is on the denylist even if the title contains kana', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 1,
        items: [
          // 张学友 with a kana-bearing fake title — kana presence in title
          // does not override the artist denylist.
          { pro: 1, indexTitle: 'カラオケのうた', indexSong: '张学友', publishdate: '1998-01-01' },
        ],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records).toEqual([]);
  });

  it('keeps records by Japanese pure-Han artists not in the denylist (e.g. 米津玄師, 嵐)', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 2,
        items: [
          { pro: 1, indexTitle: '感電', indexSong: '米津玄師', publishdate: '2020-07-22' },
          { pro: 2, indexTitle: 'Happiness', indexSong: '嵐', publishdate: '2007-09-05' },
        ],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records.length).toBe(2);
    expect(records[0]?.artist_primary).toBe('米津玄師');
    expect(records[1]?.artist_primary).toBe('嵐');
  });

  it('matches denylist entries irrespective of internal whitespace (王 菲 == 王菲)', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 3,
        items: [
          { pro: 1, indexTitle: '紅日', indexSong: '王 菲', publishdate: '1995-01-01' },
          { pro: 2, indexTitle: '容易受傷的女人', indexSong: '王  菲', publishdate: '1992-01-01' },
          { pro: 3, indexTitle: '我願意', indexSong: '王菲', publishdate: '1994-01-01' },
        ],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records).toEqual([]);
  });

  it('CHINESE_ARTIST_DENYLIST has unique normalized entries', () => {
    const seen = new Set<string>();
    for (const name of CHINESE_ARTIST_DENYLIST) {
      const key = name.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('parseCatalogResponse — blog-whitelist rescue (refinement 2)', () => {
  it('normally drops an all-Latin Japanese act (e.g. GRANRODEO)', () => {
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
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records).toEqual([]);
  });

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
    const records = parseCatalogResponse(json, SOURCE_URL, {
      forceIncludeTjNumbers: new Set(['12345']),
    });
    expect(records.length).toBe(1);
    expect(records[0]?.artist_primary).toBe('GRANRODEO');
    expect(records[0]?.karaoke_numbers.tj).toBe('12345');
  });

  it('rescue overrides the Chinese denylist when the blog already knows the TJ#', () => {
    // Decision: if the blog corpus has a record at this TJ#, the blog is
    // canonical — trust it over the denylist. A misclassified blog record
    // would land here, but the blog adapter is hand-curated for Japanese acts.
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 1,
        items: [{ pro: 99999, indexTitle: '吻別', indexSong: '张学友', publishdate: '1993-03-08' }],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL, {
      forceIncludeTjNumbers: new Set(['99999']),
    });
    expect(records.length).toBe(1);
    expect(records[0]?.artist_primary).toBe('张学友');
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
    const records = parseCatalogResponse(json, SOURCE_URL, {
      forceIncludeTjNumbers: new Set(['1', '2']),
    });
    expect(records).toEqual([]);
  });
});

describe('parseCatalogResponse — direct unit cases', () => {
  it('returns an empty array when items is empty', () => {
    const empty = {
      resultCode: '00',
      resultData: { itemsTotalCount: 0, items: [] },
      resultMsg: 'ok',
    };
    expect(parseCatalogResponse(empty, SOURCE_URL)).toEqual([]);
  });

  it('skips items with missing/empty pro, indexTitle, or indexSong', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 4,
        items: [
          // valid JP record
          { pro: 1, indexTitle: 'アイドル', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          // missing pro
          { pro: null, indexTitle: 'アイドル2', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          // empty title
          { pro: 2, indexTitle: '', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          // empty artist
          { pro: 3, indexTitle: 'アイドル3', indexSong: '', publishdate: '2023-05-24' },
        ],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records.length).toBe(1);
    expect(records[0]?.karaoke_numbers.tj).toBe('1');
  });

  it('throws when response is not an object', () => {
    expect(() => parseCatalogResponse(null, SOURCE_URL)).toThrow(/not a JSON object/);
    expect(() => parseCatalogResponse('a string', SOURCE_URL)).toThrow(/not a JSON object/);
    expect(() => parseCatalogResponse(42, SOURCE_URL)).toThrow(/not a JSON object/);
  });

  it('throws when resultData is missing or wrong shape', () => {
    expect(() => parseCatalogResponse({}, SOURCE_URL)).toThrow(/resultData/);
    expect(() => parseCatalogResponse({ resultData: 'oops' }, SOURCE_URL)).toThrow(/resultData/);
  });

  it('throws when items is not an array', () => {
    expect(() =>
      parseCatalogResponse({ resultData: { items: 'not an array' } }, SOURCE_URL),
    ).toThrow(/items is not an array/);
    expect(() => parseCatalogResponse({ resultData: { items: null } }, SOURCE_URL)).toThrow(
      /items is not an array/,
    );
  });
});
