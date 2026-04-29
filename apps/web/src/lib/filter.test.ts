import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { filterByCategory, filterByVendors } from './filter.js';

function rec(
  id: string,
  categories: SongRecord['categories'],
  karaoke_numbers: SongRecord['karaoke_numbers'] = { tj: null, ky: null, joysound: null },
): SongRecord {
  return {
    id,
    source_url: `https://example.test/${id}`,
    title_primary: id,
    title_ko: null,
    artist_primary: id,
    artist_ko: null,
    karaoke_numbers,
    categories,
    crawled_at: '2026-04-26T00:00:00.000Z',
  };
}

describe('filterByCategory (single-select filter)', () => {
  const records: SongRecord[] = [
    rec('a', ['jpop']),
    rec('b', ['jpop', 'anime']),
    rec('c', ['anime']),
    rec('d', ['vocaloid']),
    rec('e', ['jpop', 'vocaloid', 'anime']),
  ];

  it("returns input unchanged when 'all' is selected", () => {
    const out = filterByCategory(records, 'all');
    expect(out).toHaveLength(records.length);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it("'jpop' keeps records whose categories array contains jpop", () => {
    const out = filterByCategory(records, 'jpop');
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'e']);
  });

  it("'vocaloid' keeps records whose categories array contains vocaloid", () => {
    const out = filterByCategory(records, 'vocaloid');
    expect(out.map((r) => r.id)).toEqual(['d', 'e']);
  });

  it("'anime' keeps records whose categories array contains anime", () => {
    const out = filterByCategory(records, 'anime');
    expect(out.map((r) => r.id)).toEqual(['b', 'c', 'e']);
  });
});

describe('filterByVendors (OR filter)', () => {
  const records: SongRecord[] = [
    rec('tj-only', ['jpop'], { tj: '12345', ky: null, joysound: null }),
    rec('ky-only', ['jpop'], { tj: null, ky: '67890', joysound: null }),
    rec('joy-only', ['jpop'], { tj: null, ky: null, joysound: '11111' }),
    rec('tj-and-joy', ['jpop'], { tj: '22222', ky: null, joysound: '33333' }),
    rec('none', ['jpop'], { tj: null, ky: null, joysound: null }),
  ];

  it('returns input unchanged when no vendors are selected', () => {
    const out = filterByVendors(records, new Set());
    expect(out.map((r) => r.id)).toEqual(['tj-only', 'ky-only', 'joy-only', 'tj-and-joy', 'none']);
  });

  it('single vendor filters out records with null on that field', () => {
    const out = filterByVendors(records, new Set(['tj']));
    expect(out.map((r) => r.id)).toEqual(['tj-only', 'tj-and-joy']);
  });

  it('multi-vendor uses OR semantics (passes if any selected vendor non-null)', () => {
    const out = filterByVendors(records, new Set(['tj', 'ky']));
    expect(out.map((r) => r.id)).toEqual(['tj-only', 'ky-only', 'tj-and-joy']);
  });

  it('records with all vendors null never pass when any vendor is selected', () => {
    const out = filterByVendors(records, new Set(['tj', 'ky', 'joysound']));
    expect(out.map((r) => r.id)).not.toContain('none');
  });
});
