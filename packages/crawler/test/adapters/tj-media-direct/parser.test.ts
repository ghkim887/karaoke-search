import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseListingPage } from '../../../src/adapters/tj-media-direct/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/jpop-page-1.html');

describe('parseListingPage — YOASOBI page 1 fixture', () => {
  const html = readFileSync(FIXTURE_PATH, 'utf8');
  const url =
    'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=2&searchTxt=YOASOBI&pageNo=1&pageRowCnt=100';
  const records = parseListingPage(html, url);

  it('extracts at least 10 rows from the fixture', () => {
    expect(records.length).toBeGreaterThanOrEqual(10);
  });

  it('first row matches the YOASOBI sample (アイドル / TJ 68781)', () => {
    expect(records[0]).toBeDefined();
    expect(records[0]?.karaoke_numbers.tj).toBe('68781');
    expect(records[0]?.title_primary).toBe('アイドル(推しの子 OP)');
    expect(records[0]?.artist_primary).toBe('YOASOBI');
  });

  it('every parsed tj is digits-only', () => {
    for (const r of records) {
      const tj = r.karaoke_numbers.tj;
      expect(tj).not.toBeNull();
      expect(tj).toMatch(/^\d+$/);
    }
  });

  it('does NOT include the header row (grid-container.top.music)', () => {
    // Header cells contain Korean column labels (곡 번호 / 곡 제목 / 가수);
    // they do not yield digits-only TJ#s, so the regex above already
    // excludes them. Add a direct assertion that no record's title equals
    // any of the header labels.
    const headerLabels = new Set(['곡 번호', '곡 제목', '가수', '작사가', '작곡가']);
    for (const r of records) {
      expect(headerLabels.has(r.title_primary)).toBe(false);
    }
  });

  it('every record carries the source_url passed in', () => {
    for (const r of records) {
      expect(r.source_url).toBe(url);
    }
  });

  it('every record has Korean fields and release_year null at the parser layer', () => {
    for (const r of records) {
      expect(r.title_ko).toBeNull();
      expect(r.artist_ko).toBeNull();
      expect(r.release_year).toBeNull();
      expect(r.karaoke_numbers.ky).toBeNull();
      expect(r.karaoke_numbers.joysound).toBeNull();
    }
  });

  it('every record carries categories=["jpop"]', () => {
    for (const r of records) {
      expect(r.categories).toEqual(['jpop']);
    }
  });
});

describe('parseListingPage — empty page', () => {
  it('produces an empty array when the result list is empty', () => {
    // TJ's "no results" body has no chart-list-area UL. Simulate with a
    // bare html shell.
    const html = '<html><body><div>검색 결과를 찾을 수 없습니다.</div></body></html>';
    const records = parseListingPage(html, 'https://www.tjmedia.com/song/accompaniment_search');
    expect(records).toEqual([]);
  });

  it('does not throw on entirely malformed HTML', () => {
    expect(() =>
      parseListingPage('<not really html', 'https://www.tjmedia.com/song/accompaniment_search'),
    ).not.toThrow();
  });
});
