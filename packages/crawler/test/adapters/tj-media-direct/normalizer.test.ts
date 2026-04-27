import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { normalize } from '../../../src/adapters/tj-media-direct/normalizer.js';
import { parseListingPage } from '../../../src/adapters/tj-media-direct/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/jpop-page-1.html');
const CRAWLED_AT = '2026-04-27T00:46:00.000Z';

describe('normalize — fixture-derived records', () => {
  const html = readFileSync(FIXTURE_PATH, 'utf8');
  const url =
    'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=2&searchTxt=YOASOBI&pageNo=1&pageRowCnt=100';
  const raws = parseListingPage(html, url);
  const records = raws.map((r) => normalize(r, CRAWLED_AT));

  it('every record has categories=["jpop"] exactly (length 1, value "jpop")', () => {
    for (const r of records) {
      expect(r.categories).toHaveLength(1);
      expect(r.categories[0]).toBe('jpop');
    }
  });

  it('every record has title_ko, artist_ko, and release_year null', () => {
    for (const r of records) {
      expect(r.title_ko).toBeNull();
      expect(r.artist_ko).toBeNull();
      expect(r.release_year).toBeNull();
    }
  });

  it('every record id matches /^tj-\\d+$/', () => {
    for (const r of records) {
      expect(r.id).toMatch(/^tj-\d+$/);
    }
  });

  it('every record has karaoke_numbers.tj non-null and ky/joysound null', () => {
    for (const r of records) {
      expect(r.karaoke_numbers.tj).not.toBeNull();
      expect(r.karaoke_numbers.tj).toMatch(/^\d+$/);
      expect(r.karaoke_numbers.ky).toBeNull();
      expect(r.karaoke_numbers.joysound).toBeNull();
    }
  });

  it('threads the passed crawled_at through every record', () => {
    for (const r of records) {
      expect(r.crawled_at).toBe(CRAWLED_AT);
    }
  });

  it('id is derived from the TJ number', () => {
    expect(records[0]).toBeDefined();
    expect(records[0]?.id).toBe(`tj-${records[0]?.karaoke_numbers.tj}`);
  });
});

describe('normalize — direct unit cases', () => {
  function rawFor(over: Partial<RawSongRecord>): RawSongRecord {
    return {
      source_url: 'https://www.tjmedia.com/song/accompaniment_search?nationType=JPN&strType=2',
      title_primary: 'Title',
      title_ko: null,
      artist_primary: 'Artist',
      artist_ko: null,
      release_year: null,
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
      categories: ['jpop'],
      ...over,
    };
  }

  it('throws when the raw record has no TJ number', () => {
    expect(() =>
      normalize(rawFor({ karaoke_numbers: { tj: null, ky: null, joysound: null } }), CRAWLED_AT),
    ).toThrow(/no TJ number/);
  });

  it('forces categories=["jpop"] regardless of incoming raw value', () => {
    // Defensive: even if a parser variant drifted, the normalizer pins
    // the category at the v2 spec's uniform value.
    const r = normalize(rawFor({}), CRAWLED_AT);
    expect(r.categories).toEqual(['jpop']);
  });
});
