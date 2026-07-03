import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchBackend } from './backend.js';
import * as searchModule from './search.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSearchBackend factory', () => {
  it('returns the offline backend when no API base URL is configured', () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue(null);
    const backend = createSearchBackend();
    expect(backend.requiresLocalCorpus).toBe(true);
  });

  it('returns the API backend when an API base URL is configured', () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const backend = createSearchBackend();
    expect(backend.requiresLocalCorpus).toBe(false);
  });
});

describe('offline backend', () => {
  it('loadCorpus delegates to loadIndex', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue(null);
    // biome-ignore lint/suspicious/noExplicitAny: minimal IndexBundle stub for tests
    const stub = { index: { search: () => [] }, byId: new Map() } as any;
    const spy = vi.spyOn(searchModule, 'loadIndex').mockResolvedValue(stub);
    const backend = createSearchBackend();
    await expect(backend.loadCorpus()).resolves.toBe(stub);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('API backend', () => {
  it('loadCorpus resolves null and never downloads the corpus', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const loadSpy = vi.spyOn(searchModule, 'loadIndex');
    const backend = createSearchBackend();
    await expect(backend.loadCorpus()).resolves.toBeNull();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('browse forwards the base URL, query, limit and a non-empty vendor union', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const record: SongRecord = {
      id: 'r1',
      title_primary: 'x',
      title_ko: null,
      artist_primary: 'y',
      artist_ko: null,
      karaoke_numbers: { tj: '1', ky: null, joysound: null },
      source_url: 'https://example.invalid',
      crawled_at: '2026-04-29T00:00:00.000Z',
    };
    const spy = vi.spyOn(searchModule, 'searchApi').mockResolvedValue([record]);
    const backend = createSearchBackend();

    await backend.browse('kick', ['ky', 'tj'], 50);
    expect(spy).toHaveBeenCalledWith(
      'https://api.example.test',
      expect.objectContaining({ query: 'kick', limit: 50, vendors: ['ky', 'tj'] }),
    );

    spy.mockClear();
    await backend.browse('kick', [], 50);
    const opts = spy.mock.calls[0]?.[1] as { vendors?: unknown };
    // No vendor chips selected → no `vendors` param.
    expect(opts.vendors).toBeUndefined();
  });

  it('getFavorites delegates to fetchSongsByIds with the base URL and ids', async () => {
    vi.spyOn(searchModule, 'getApiSearchBaseUrl').mockReturnValue('https://api.example.test');
    const spy = vi.spyOn(searchModule, 'fetchSongsByIds').mockResolvedValue([]);
    const backend = createSearchBackend();
    await backend.getFavorites(['r2', 'r1']);
    expect(spy).toHaveBeenCalledWith('https://api.example.test', ['r2', 'r1']);
  });
});
