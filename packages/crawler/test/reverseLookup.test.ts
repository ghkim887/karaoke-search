import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { computeBlogReverseLookup } from '../src/reverseLookup.js';

function rec(over: Partial<SongRecord>): SongRecord {
  return {
    id: 'blog-1-tj-100',
    source_url: 'https://blog.test/1',
    title_primary: 'T',
    title_ko: null,
    artist_primary: 'A',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    crawled_at: '2026-07-14T00:00:00Z',
    ...over,
  };
}

describe('computeBlogReverseLookup', () => {
  it('collects claimed TJ numbers on standalone blog records into the probe seed', () => {
    const out = computeBlogReverseLookup([
      rec({ id: 'blog-1-tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
      rec({ id: 'blog-2-tj-200', karaoke_numbers: { tj: '200', ky: null, joysound: null } }),
    ]);
    expect(out.tjProbeSeed).toEqual(['100', '200']);
    expect(out.joysoundDelistedReport).toEqual([]);
  });

  it('collects claimed JOYSOUND numbers on standalone blog records into the delisted report', () => {
    const out = computeBlogReverseLookup([
      rec({
        id: 'blog-3-joysound-900',
        karaoke_numbers: { tj: null, ky: null, joysound: '900' },
      }),
    ]);
    expect(out.joysoundDelistedReport).toEqual(['900']);
    expect(out.tjProbeSeed).toEqual([]);
  });

  it('ignores records that merged under a vendor id (not standalone blog)', () => {
    const out = computeBlogReverseLookup([
      rec({ id: 'tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
      rec({ id: 'joysound-900', karaoke_numbers: { tj: null, ky: null, joysound: '900' } }),
      rec({ id: 'tjpdf-5', karaoke_numbers: { tj: '5', ky: null, joysound: null } }),
    ]);
    expect(out.tjProbeSeed).toEqual([]);
    expect(out.joysoundDelistedReport).toEqual([]);
  });

  it('leaves KY untouched, and de-duplicates + sorts both sets', () => {
    const out = computeBlogReverseLookup([
      // KY-only standalone: contributes to neither the TJ seed nor JOYSOUND report.
      rec({ id: 'blog-9-ky-44', karaoke_numbers: { tj: null, ky: '44', joysound: null } }),
      rec({ id: 'blog-5-tj-300', karaoke_numbers: { tj: '300', ky: null, joysound: null } }),
      rec({ id: 'blog-6-tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
      // A standalone blog record can carry both a TJ and a JOYSOUND claim.
      rec({ id: 'blog-7-tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: '900' } }),
    ]);
    expect(out.tjProbeSeed).toEqual(['100', '300']);
    expect(out.joysoundDelistedReport).toEqual(['900']);
  });
});
