import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchBackend, isFallbackStatusSource } from './backend.js';
import type { IndexBundle } from './search.js';
import * as searchModule from './search.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const API = 'https://api.example.test';

function rec(id: string, over: Partial<SongRecord> = {}): SongRecord {
  return {
    id,
    title_primary: `title-${id}`,
    title_ko: null,
    artist_primary: `artist-${id}`,
    artist_ko: null,
    karaoke_numbers: { tj: '1', ky: null, joysound: null },
    source_url: 'https://example.invalid',
    crawled_at: '2026-04-29T00:00:00.000Z',
    ...over,
  };
}

/** Build a fake IndexBundle whose `index.search(query)` returns the records
 *  whose id/title/artist contains the (lowercased) query, in `records` order. */
function fakeBundle(records: SongRecord[]): IndexBundle {
  const byId = new Map(records.map((r) => [r.id, r] as const));
  const index = {
    search: (q: string) => {
      const lower = q.toLowerCase();
      return records
        .filter(
          (r) =>
            r.id.toLowerCase().includes(lower) ||
            r.title_primary.toLowerCase().includes(lower) ||
            r.artist_primary.toLowerCase().includes(lower),
        )
        .map((r) => ({ id: r.id }));
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal MiniSearch stub for tests
  } as any;
  return { index, byId };
}

function apiBackend() {
  vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue(API);
  return createSearchBackend();
}

describe('FallbackBackend — healthy API path (byte-preserving)', () => {
  it('is the fallback-status source and reports inactive initially', () => {
    const backend = apiBackend();
    expect(backend.requiresLocalCorpus).toBe(false);
    expect(isFallbackStatusSource(backend)).toBe(true);
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(false);
  });

  it('browse returns the API result and never loads the local corpus', async () => {
    const backend = apiBackend();
    const record = rec('r1');
    const apiSpy = vi.spyOn(searchModule, 'searchApi').mockResolvedValue([record]);
    const loadSpy = vi.spyOn(searchModule, 'loadIndex');

    await expect(backend.browse('title', [], 50)).resolves.toEqual([record]);
    expect(apiSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).not.toHaveBeenCalled();
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(false);
  });

  it('getFavorites returns the API result and never loads the local corpus', async () => {
    const backend = apiBackend();
    const record = rec('r2');
    const fetchSpy = vi.spyOn(searchModule, 'fetchSongsByIds').mockResolvedValue([record]);
    const loadSpy = vi.spyOn(searchModule, 'loadIndex');

    await expect(backend.getFavorites(['r2'])).resolves.toEqual([record]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).not.toHaveBeenCalled();
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(false);
  });

  it('loadCorpus resolves null without downloading the corpus', async () => {
    const backend = apiBackend();
    const loadSpy = vi.spyOn(searchModule, 'loadIndex');
    await expect(backend.loadCorpus()).resolves.toBeNull();
    expect(loadSpy).not.toHaveBeenCalled();
  });
});

describe('FallbackBackend — browse fallback on API failure', () => {
  it('falls back to a local index search when the API browse throws', async () => {
    const backend = apiBackend();
    const corpus = [
      rec('r1', { title_primary: 'kick back' }),
      rec('r2', { title_primary: 'lemon' }),
    ];
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(new Error('network down'));
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle(corpus));

    const result = await backend.browse('lemon', [], 50);
    expect(result.map((r) => r.id)).toEqual(['r2']);
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(true);
  });

  it('applies the vendor filter and the result cap to the fallback set', async () => {
    const backend = apiBackend();
    const corpus = [
      rec('a', { title_primary: 'song', karaoke_numbers: { tj: '1', ky: null, joysound: null } }),
      rec('b', { title_primary: 'song', karaoke_numbers: { tj: null, ky: '2', joysound: null } }),
      rec('c', { title_primary: 'song', karaoke_numbers: { tj: '3', ky: null, joysound: null } }),
    ];
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(new Error('down'));
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle(corpus));

    // vendor filter: only TJ-having records.
    const tjOnly = await backend.browse('song', ['tj'], 50);
    expect(tjOnly.map((r) => r.id)).toEqual(['a', 'c']);

    // result cap.
    const capped = await backend.browse('song', [], 2);
    expect(capped).toHaveLength(2);
  });

  it('re-throws the API error when the corpus is empty (no fallback available)', async () => {
    const backend = apiBackend();
    const apiError = new Error('network down');
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(apiError);
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle([]));

    await expect(backend.browse('anything', [], 50)).rejects.toBe(apiError);
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(false);
  });

  it('re-throws the API error when the corpus fails to load (cold offline cache)', async () => {
    const backend = apiBackend();
    const apiError = new Error('network down');
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(apiError);
    vi.spyOn(searchModule, 'loadIndex').mockRejectedValue(new Error('songs.json unavailable'));

    await expect(backend.browse('anything', [], 50)).rejects.toBe(apiError);
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(false);
  });

  it('loads the corpus at most once across repeated failures (memoized)', async () => {
    const backend = apiBackend();
    const corpus = [rec('r1', { title_primary: 'kick' })];
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(new Error('down'));
    const loadSpy = vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle(corpus));

    await backend.browse('kick', [], 50);
    await backend.browse('kick', [], 50);
    await backend.browse('kick', [], 50);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});

describe('FallbackBackend — getFavorites fallback on API failure', () => {
  it('resolves favorites from the local corpus when hydration throws', async () => {
    const backend = apiBackend();
    const corpus = [rec('r1'), rec('r2'), rec('r3')];
    vi.spyOn(searchModule, 'fetchSongsByIds').mockRejectedValue(new Error('down'));
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle(corpus));

    const result = await backend.getFavorites(['r3', 'r1']);
    // Resolved in the requested id order; unknown ids are skipped.
    expect(result.map((r) => r.id)).toEqual(['r3', 'r1']);
    if (isFallbackStatusSource(backend)) expect(backend.isFallbackActive()).toBe(true);
  });

  it('re-throws the API error when the corpus is empty', async () => {
    const backend = apiBackend();
    const apiError = new Error('down');
    vi.spyOn(searchModule, 'fetchSongsByIds').mockRejectedValue(apiError);
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle([]));

    await expect(backend.getFavorites(['r1'])).rejects.toBe(apiError);
  });
});

describe('FallbackBackend — fallback status subscription', () => {
  it('notifies subscribers when the active flag changes and reflects recovery', async () => {
    const backend = apiBackend();
    if (!isFallbackStatusSource(backend)) throw new Error('expected fallback status source');
    const corpus = [rec('r1', { title_primary: 'kick' })];
    vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(fakeBundle(corpus));

    const events: boolean[] = [];
    const unsub = backend.subscribeFallback(() => events.push(backend.isFallbackActive()));

    // API fails → fallback engages → listener sees true.
    const apiSpy = vi
      .spyOn(searchModule, 'searchApi')
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue([rec('r9')]);
    await backend.browse('kick', [], 50);
    expect(backend.isFallbackActive()).toBe(true);

    // API recovers → fallback clears → listener sees false.
    await backend.browse('kick', [], 50);
    expect(backend.isFallbackActive()).toBe(false);

    expect(events).toEqual([true, false]);
    expect(apiSpy).toHaveBeenCalledTimes(2);

    unsub();
    // After unsubscribe no further events are recorded.
    vi.spyOn(searchModule, 'searchApi').mockRejectedValue(new Error('down again'));
    await backend.browse('kick', [], 50);
    expect(events).toEqual([true, false]);
  });
});
