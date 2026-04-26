import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { mergeRecords } from '../src/merge.js';

function record(over: Partial<SongRecord>): SongRecord {
  return {
    id: 'blog-1-0',
    source_url: 'https://example.test/1',
    title_primary: 'あぶく',
    title_ko: null,
    artist_primary: 'ヨルシカ',
    artist_ko: null,
    release_year: 2023,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-04-26T10:00:00Z',
    ...over,
  };
}

describe('mergeRecords', () => {
  it('retains both karaoke numbers when sources contribute different non-null fields', () => {
    const a = record({
      id: 'blog-1-0',
      source_url: 'https://blog.test/1',
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    });
    const b = record({
      id: 'tj-9-0',
      source_url: 'https://tj.test/9',
      karaoke_numbers: { tj: null, ky: '67890', joysound: null },
    });
    const out = mergeRecords([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.karaoke_numbers).toEqual({ tj: '12345', ky: '67890', joysound: null });
  });

  it('keeps a single record when both sources provide the same number; first wins', () => {
    const a = record({
      id: 'blog-1-0',
      source_url: 'https://blog.test/1',
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    });
    const b = record({
      id: 'tj-9-0',
      source_url: 'https://tj.test/9',
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
    });
    const out = mergeRecords([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.karaoke_numbers.tj).toBe('12345');
    expect(out[0]?.source_url).toBe('https://blog.test/1');
    expect(out[0]?.id).toBe('blog-1-0');
  });

  it('union-dedupes and alphabetically sorts categories from collisions', () => {
    const a = record({ id: 'blog-1-0', categories: ['vocaloid'] });
    const b = record({ id: 'tj-9-0', categories: ['jpop'] });
    const out = mergeRecords([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]?.categories).toEqual(['jpop', 'vocaloid']);
  });

  it('breaks within-source ties by lower crawled_at on the title fields', () => {
    const later = record({
      id: 'blog-1-0',
      title_primary: 'あぶく',
      title_ko: 'LATER',
      crawled_at: '2026-04-26T11:00:00Z',
    });
    const earlier = record({
      id: 'blog-1-0',
      title_primary: 'あぶく',
      title_ko: 'EARLIER',
      crawled_at: '2026-04-26T09:00:00Z',
    });
    // `later` arrives first in registration order; the same-source tie-break
    // by lower crawled_at must displace it with `earlier`.
    const out = mergeRecords([later, earlier]);
    expect(out).toHaveLength(1);
    expect(out[0]?.title_ko).toBe('EARLIER');
    expect(out[0]?.crawled_at).toBe('2026-04-26T09:00:00Z');
  });

  it('preserves first-seen identity-key order across distinct songs', () => {
    const a = record({ id: 'blog-1-0', title_primary: 'first', artist_primary: 'X' });
    const b = record({ id: 'blog-2-0', title_primary: 'second', artist_primary: 'X' });
    const out = mergeRecords([a, b]);
    expect(out.map((r) => r.title_primary)).toEqual(['first', 'second']);
  });
});
