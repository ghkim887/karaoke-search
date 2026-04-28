import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { normalizeRawRecords } from '../../../src/adapters/jpop-playlist-blog/normalizer.js';

const CRAWLED_AT = '2026-04-26T12:00:00.000Z';

function rawRecord(over: Partial<RawSongRecord>): RawSongRecord {
  return {
    source_url: 'https://j-pop-playlist.tistory.com/449',
    title_primary: 'Title',
    title_ko: '제목',
    artist_primary: 'Artist',
    artist_ko: '아티스트',
    karaoke_numbers: { tj: '1', ky: '2', joysound: '3' },
    categories: [],
    ...over,
  };
}

describe('normalizeRawRecords', () => {
  it('builds id of shape blog-{n}-{rowIndex}', () => {
    const recs = normalizeRawRecords(
      [rawRecord({}), rawRecord({}), rawRecord({})],
      '/449',
      ['jpop'],
      CRAWLED_AT,
    );
    expect(recs.map((r) => r.id)).toEqual(['blog-449-0', 'blog-449-1', 'blog-449-2']);
    for (const r of recs) {
      expect(r.id).toMatch(/^blog-\d+-\d+$/);
    }
  });

  it('tags categories ["jpop"] for a /98-only artist', () => {
    const recs = normalizeRawRecords([rawRecord({})], '/449', ['jpop'], CRAWLED_AT);
    expect(recs[0]?.categories).toEqual(['jpop']);
  });

  it('tags categories ["vocaloid"] for a /417-only artist', () => {
    const recs = normalizeRawRecords([rawRecord({})], '/418', ['vocaloid'], CRAWLED_AT);
    expect(recs[0]?.categories).toEqual(['vocaloid']);
  });

  it('tags categories ["jpop", "vocaloid"] for an artist in both indexes', () => {
    const recs = normalizeRawRecords([rawRecord({})], '/100', ['jpop', 'vocaloid'], CRAWLED_AT);
    expect(recs[0]?.categories).toEqual(['jpop', 'vocaloid']);
  });

  it('threads the passed crawled_at through every record', () => {
    const recs = normalizeRawRecords([rawRecord({}), rawRecord({})], '/449', ['jpop'], CRAWLED_AT);
    for (const r of recs) {
      expect(r.crawled_at).toBe(CRAWLED_AT);
    }
  });

  it('throws when artistPath does not match /\\d+/', () => {
    expect(() => normalizeRawRecords([rawRecord({})], 'invalid', ['jpop'], CRAWLED_AT)).toThrow();
  });
});
