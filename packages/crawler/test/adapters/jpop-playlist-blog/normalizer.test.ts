import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import {
  type NormalizeResult,
  mintBlogRecordId,
  normalizeRawRecords,
} from '../../../src/adapters/jpop-playlist-blog/normalizer.js';

const CRAWLED_AT = '2026-04-26T12:00:00.000Z';

function rawRecord(over: Partial<RawSongRecord>): RawSongRecord {
  return {
    source_url: 'https://j-pop-playlist.tistory.com/449',
    title_primary: 'Title',
    title_ko: '제목',
    artist_primary: 'Artist',
    artist_ko: '아티스트',
    karaoke_numbers: { tj: '1', ky: '2', joysound: '3' },
    ...over,
  };
}

describe('mintBlogRecordId', () => {
  it('mints from the first non-null vendor in tj → ky → joysound order', () => {
    expect(mintBlogRecordId('416', { tj: '26723', ky: '44001', joysound: '677515' })).toBe(
      'blog-416-tj-26723',
    );
    expect(mintBlogRecordId('416', { tj: null, ky: '44001', joysound: '677515' })).toBe(
      'blog-416-ky-44001',
    );
    expect(mintBlogRecordId('299', { tj: null, ky: null, joysound: '677515' })).toBe(
      'blog-299-joysound-677515',
    );
  });

  it('returns null when the row claims no vendor number', () => {
    expect(mintBlogRecordId('449', { tj: null, ky: null, joysound: null })).toBeNull();
  });

  it('mints ids that satisfy the schema id pattern and keep the blog first segment', () => {
    const id = mintBlogRecordId('416', { tj: null, ky: null, joysound: '677515' });
    expect(id).toMatch(/^[a-z0-9-]+-\d+$/);
    expect(id).toMatch(/^blog-/);
  });
});

describe('normalizeRawRecords', () => {
  it('mints ids of shape blog-{artistId}-{vendor}-{number} from the first claimed number', () => {
    const { records } = normalizeRawRecords(
      [
        rawRecord({ karaoke_numbers: { tj: '26723', ky: null, joysound: null } }),
        rawRecord({ karaoke_numbers: { tj: null, ky: '44001', joysound: null } }),
        rawRecord({ karaoke_numbers: { tj: null, ky: null, joysound: '677515' } }),
      ],
      '/416',
      CRAWLED_AT,
    );
    expect(records.map((r) => r.id)).toEqual([
      'blog-416-tj-26723',
      'blog-416-ky-44001',
      'blog-416-joysound-677515',
    ]);
    for (const r of records) {
      expect(r.id).toMatch(/^[a-z0-9-]+-\d+$/);
    }
  });

  it('drops rows with no vendor number and reports them (numberless drop rule)', () => {
    const result: NormalizeResult = normalizeRawRecords(
      [
        rawRecord({
          title_primary: 'Kept',
          karaoke_numbers: { tj: '1', ky: null, joysound: null },
        }),
        rawRecord({
          title_primary: 'Numberless',
          artist_primary: 'Nobody',
          karaoke_numbers: { tj: null, ky: null, joysound: null },
        }),
      ],
      '/449',
      CRAWLED_AT,
    );
    expect(result.records.map((r) => r.title_primary)).toEqual(['Kept']);
    expect(result.dropped).toEqual([
      {
        title_primary: 'Numberless',
        artist_primary: 'Nobody',
        source_url: 'https://j-pop-playlist.tistory.com/449',
      },
    ]);
  });

  it('drops a row whose only number cell was voided by the parser (all-null caveat path)', () => {
    // A row that arrived with every karaoke number already nulled — e.g. the
    // parser voided a multi-value / junk cell — is indistinguishable from a
    // genuinely numberless row and falls out the same way. The report makes it
    // visible; cell semantics stay as-is.
    const { records, dropped } = normalizeRawRecords(
      [
        rawRecord({
          title_primary: 'ParserVoided',
          karaoke_numbers: { tj: null, ky: null, joysound: null },
        }),
      ],
      '/523',
      CRAWLED_AT,
    );
    expect(records).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.title_primary).toBe('ParserVoided');
  });

  it('throws on a duplicate minted id within one run (same first-vendor number twice)', () => {
    expect(() =>
      normalizeRawRecords(
        [
          rawRecord({ karaoke_numbers: { tj: '26723', ky: null, joysound: null } }),
          rawRecord({ karaoke_numbers: { tj: '26723', ky: null, joysound: null } }),
        ],
        '/416',
        CRAWLED_AT,
      ),
    ).toThrow(/duplicate minted id/);
  });

  it('does not collide when two rows share a later-vendor number but mint from different vendors', () => {
    // Row A mints from tj, row B mints from joysound — distinct ids even though
    // both carry the same joysound number. Minting reads only the first vendor.
    const { records } = normalizeRawRecords(
      [
        rawRecord({ karaoke_numbers: { tj: '100', ky: null, joysound: '900' } }),
        rawRecord({ karaoke_numbers: { tj: null, ky: null, joysound: '900' } }),
      ],
      '/1',
      CRAWLED_AT,
    );
    expect(records.map((r) => r.id)).toEqual(['blog-1-tj-100', 'blog-1-joysound-900']);
  });

  it('threads the passed crawled_at through every record', () => {
    const { records } = normalizeRawRecords(
      [
        rawRecord({ karaoke_numbers: { tj: '1', ky: null, joysound: null } }),
        rawRecord({ karaoke_numbers: { tj: '2', ky: null, joysound: null } }),
      ],
      '/449',
      CRAWLED_AT,
    );
    for (const r of records) {
      expect(r.crawled_at).toBe(CRAWLED_AT);
    }
  });

  it('throws when artistPath does not match /\\d+/', () => {
    expect(() => normalizeRawRecords([rawRecord({})], 'invalid', CRAWLED_AT)).toThrow();
  });
});
