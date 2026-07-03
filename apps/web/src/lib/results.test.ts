import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import type { Vendor } from '../components/VendorChips.js';
import {
  type ApiBrowseState,
  apiBrowseKey,
  finalizeResults,
  resolveBrowseCandidates,
  resolveFavoriteCandidates,
  selectedVendorsForApi,
} from './results.js';
import { buildIndex } from './search.js';

function rec(over: Partial<SongRecord> & Pick<SongRecord, 'id'>): SongRecord {
  return {
    title_primary: `title-${over.id}`,
    title_ko: null,
    artist_primary: `artist-${over.id}`,
    artist_ko: null,
    karaoke_numbers: { tj: '1', ky: null, joysound: null },
    source_url: 'https://example.invalid',
    crawled_at: '2026-04-29T00:00:00.000Z',
    ...over,
  };
}

const IDLE: ApiBrowseState = { key: '', records: null, status: 'idle' };

describe('apiBrowseKey / selectedVendorsForApi', () => {
  it('sorts vendors deterministically and is order-independent', () => {
    const a = apiBrowseKey('q', new Set<Vendor>(['ky', 'tj']));
    const b = apiBrowseKey('q', new Set<Vendor>(['tj', 'ky']));
    expect(a).toBe(b);
    expect(selectedVendorsForApi(new Set<Vendor>(['ky', 'tj']))).toEqual(['ky', 'tj']);
  });

  it('separates query from vendor segment so they cannot collide', () => {
    // "a" + <sep> + "tj"  must differ from  "a,tj" + <sep> + ""
    expect(apiBrowseKey('a', new Set<Vendor>(['tj']))).not.toBe(
      apiBrowseKey('a,tj', new Set<Vendor>()),
    );
  });
});

describe('resolveBrowseCandidates', () => {
  const bundleRecords = [
    rec({ id: 'a', title_primary: 'alpha' }),
    rec({ id: 'b', title_primary: 'beta' }),
  ];
  const bundle = {
    index: buildIndex(bundleRecords),
    byId: new Map(bundleRecords.map((r) => [r.id, r])),
  };

  it('empty query yields no candidates', () => {
    expect(
      resolveBrowseCandidates(true, {
        query: '',
        selectedVendors: new Set(),
        bundle,
        apiBrowse: IDLE,
      }),
    ).toEqual([]);
  });

  it('offline: searches the local bundle', () => {
    const out = resolveBrowseCandidates(true, {
      query: 'alpha',
      selectedVendors: new Set(),
      bundle,
      apiBrowse: IDLE,
    });
    expect(out.map((r) => r.id)).toEqual(['a']);
  });

  it('API: uses the worker records only when the key matches the current query', () => {
    const records = [rec({ id: 'x' })];
    const key = apiBrowseKey('song', new Set());
    const matched: ApiBrowseState = { key, records, status: 'success' };
    expect(
      resolveBrowseCandidates(false, {
        query: 'song',
        selectedVendors: new Set(),
        bundle: null,
        apiBrowse: matched,
      }),
    ).toBe(records);
    // Stale key (different query) → no candidates, never falls back to a bundle.
    expect(
      resolveBrowseCandidates(false, {
        query: 'different',
        selectedVendors: new Set(),
        bundle: null,
        apiBrowse: matched,
      }),
    ).toEqual([]);
  });
});

describe('resolveFavoriteCandidates', () => {
  const r1 = rec({ id: 'r1', title_primary: 'Idol', artist_primary: 'YOASOBI' });
  const r2 = rec({ id: 'r2', title_primary: 'KICK BACK', artist_primary: 'Kenshi' });
  const favRecords = [r2, r1]; // favorite order: r2 then r1

  it('API empty query returns the fetched favorites in favorite order', () => {
    const idx = buildIndex(favRecords);
    const out = resolveFavoriteCandidates(false, {
      query: '',
      favoriteIds: ['r2', 'r1'],
      bundle: null,
      apiFavorites: favRecords,
      apiFavoriteIndex: idx,
    });
    expect(out.map((r) => r.id)).toEqual(['r2', 'r1']);
  });

  it('API query narrows via the favorites index and re-sorts to favorite order', () => {
    const idx = buildIndex(favRecords);
    const out = resolveFavoriteCandidates(false, {
      query: 'idol',
      favoriteIds: ['r2', 'r1'],
      bundle: null,
      apiFavorites: favRecords,
      apiFavoriteIndex: idx,
    });
    expect(out.map((r) => r.id)).toEqual(['r1']);
  });

  it('offline resolves ids against the bundle and narrows by query', () => {
    const all = [r1, r2];
    const bundle = { index: buildIndex(all), byId: new Map(all.map((r) => [r.id, r])) };
    const base = resolveFavoriteCandidates(true, {
      query: '',
      favoriteIds: ['r2', 'r1'],
      bundle,
      apiFavorites: null,
      apiFavoriteIndex: null,
    });
    expect(base.map((r) => r.id)).toEqual(['r2', 'r1']);
    const narrowed = resolveFavoriteCandidates(true, {
      query: 'kick',
      favoriteIds: ['r2', 'r1'],
      bundle,
      apiFavorites: null,
      apiFavoriteIndex: null,
    });
    expect(narrowed.map((r) => r.id)).toEqual(['r2']);
  });
});

describe('finalizeResults', () => {
  const records = [
    rec({ id: 'a', karaoke_numbers: { tj: '1', ky: null, joysound: null } }),
    rec({ id: 'b', karaoke_numbers: { tj: null, ky: '2', joysound: null } }),
  ];

  it('applies the vendor OR filter then caps to the limit', () => {
    expect(finalizeResults(records, new Set<Vendor>(['ky']), 50).map((r) => r.id)).toEqual(['b']);
    expect(finalizeResults(records, new Set(), 1)).toHaveLength(1);
  });
});
