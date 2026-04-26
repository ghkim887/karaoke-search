import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { filterByCategories } from './filter.js';

function rec(id: string, categories: SongRecord['categories']): SongRecord {
  return {
    id,
    source_url: `https://example.test/${id}`,
    title_primary: id,
    title_ko: null,
    artist_primary: id,
    artist_ko: null,
    release_year: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    categories,
    crawled_at: '2026-04-26T00:00:00.000Z',
  };
}

describe('filterByCategories (AND filter)', () => {
  const records: SongRecord[] = [
    rec('a', ['jpop']),
    rec('b', ['jpop', 'anime']),
    rec('c', ['anime']),
    rec('d', ['vocaloid']),
    rec('e', ['jpop', 'vocaloid', 'anime']),
  ];

  it('returns input unchanged when no categories are selected', () => {
    const out = filterByCategories(records, new Set());
    expect(out).toHaveLength(records.length);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('AND-filters across selected categories', () => {
    const out = filterByCategories(records, new Set(['jpop', 'anime']));
    const ids = out.map((r) => r.id);
    // 'a' (jpop only) does NOT match
    expect(ids).not.toContain('a');
    // 'b' (jpop + anime) matches
    expect(ids).toContain('b');
    // 'c' (anime only) does NOT match
    expect(ids).not.toContain('c');
    // 'd' (vocaloid only) does NOT match
    expect(ids).not.toContain('d');
    // 'e' (all three) matches
    expect(ids).toContain('e');
    expect(ids).toEqual(['b', 'e']);
  });

  it('single-category filter requires exact category presence', () => {
    const out = filterByCategories(records, new Set(['vocaloid']));
    expect(out.map((r) => r.id)).toEqual(['d', 'e']);
  });
});
