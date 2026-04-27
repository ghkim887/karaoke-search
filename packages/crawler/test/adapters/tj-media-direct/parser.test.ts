import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCatalogResponse } from '../../../src/adapters/tj-media-direct/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/catalog-sample.json');
const SOURCE_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

describe('parseCatalogResponse — catalog-sample.json fixture', () => {
  const records = parseCatalogResponse(FIXTURE, SOURCE_URL);

  it('extracts JP-relevant records and excludes Korean / Latin-only items', () => {
    // The fixture is hand-built with 31 JP-relevant items + 10 Korean + 10
    // English-only. The loose filter must keep exactly the JP-relevant ones.
    expect(records.length).toBe(31);
  });

  it('maps the YOASOBI アイドル record (pro=68781) per the field-map contract', () => {
    const idol = records.find((r) => r.karaoke_numbers.tj === '68781');
    expect(idol).toBeDefined();
    expect(idol?.title_primary).toBe('アイドル(推しの子 OP)');
    expect(idol?.artist_primary).toBe('YOASOBI');
    // publishdate=2023-05-24 in the live capture.
    expect(idol?.release_year).toBe(2023);
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

  it('release_year is an integer in [1900, 2100] or null', () => {
    for (const r of records) {
      const y = r.release_year;
      if (y === null) continue;
      expect(Number.isInteger(y)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(1900);
      expect(y).toBeLessThanOrEqual(2100);
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

  it('includes a Chinese Han-only record (accepted Chinese-leak per loose-JP filter design)', () => {
    // Some catalog rows have Chinese (Han-only, no Hangul, no kana) titles like
    // pro=90015 "梦底 / 海来阿木". The loose filter intentionally lets these through
    // because the Han-without-Hangul branch cannot distinguish Chinese from Japanese
    // Han characters. The accepted scope (~5% Chinese leak) is documented in the
    // spec's "Source: TJ Media direct" section. If this test starts failing, it
    // means the filter was tightened — that is a deliberate tradeoff change.
    const chineseLeak = records.find((r) => r.karaoke_numbers.tj === '90015');
    expect(chineseLeak).toBeDefined();
    expect(chineseLeak?.title_primary).toBe('梦底');
    expect(chineseLeak?.artist_primary).toBe('海来阿木');
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

  it('parses publishdate to release_year and falls back to null on bad input', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 3,
        items: [
          { pro: 1, indexTitle: 'アイドル', indexSong: 'YOASOBI', publishdate: '2023-05-24' },
          { pro: 2, indexTitle: 'アイドル2', indexSong: 'YOASOBI', publishdate: 'not-a-date' },
          { pro: 3, indexTitle: 'アイドル3', indexSong: 'YOASOBI', publishdate: '' },
        ],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records[0]?.release_year).toBe(2023);
    expect(records[1]?.release_year).toBeNull();
    expect(records[2]?.release_year).toBeNull();
  });

  it('clamps out-of-range years to null', () => {
    const json = {
      resultCode: '00',
      resultData: {
        itemsTotalCount: 2,
        items: [
          { pro: 1, indexTitle: 'アイドル', indexSong: 'YOASOBI', publishdate: '1899-12-31' },
          { pro: 2, indexTitle: 'アイドル2', indexSong: 'YOASOBI', publishdate: '2101-01-01' },
        ],
      },
    };
    const records = parseCatalogResponse(json, SOURCE_URL);
    expect(records[0]?.release_year).toBeNull();
    expect(records[1]?.release_year).toBeNull();
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
