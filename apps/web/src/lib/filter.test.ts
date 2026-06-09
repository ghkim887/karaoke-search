import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { filterByVendors } from './filter.js';

function rec(
  id: string,
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
    crawled_at: '2026-04-26T00:00:00.000Z',
  };
}

describe('filterByVendors (OR filter)', () => {
  const records: SongRecord[] = [
    rec('tj-only', { tj: '12345', ky: null, joysound: null }),
    rec('ky-only', { tj: null, ky: '67890', joysound: null }),
    rec('joy-only', { tj: null, ky: null, joysound: '11111' }),
    rec('tj-and-joy', { tj: '22222', ky: null, joysound: '33333' }),
    rec('none', { tj: null, ky: null, joysound: null }),
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
