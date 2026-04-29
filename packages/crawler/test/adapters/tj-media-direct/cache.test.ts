import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOTSTRAP_STALENESS_MS,
  CACHE_STALENESS_MS,
  CACHE_VERSION,
  emptyCache,
  isBootstrapFresh,
  isFresh,
  loadCache,
  saveCache,
} from '../../../src/adapters/tj-media-direct/cache.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tj-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadCache', () => {
  it('returns an empty cache when the file does not exist', async () => {
    const cache = await loadCache(join(dir, 'missing.json'));
    expect(cache.version).toBe(CACHE_VERSION);
    expect(cache.proEnrichmentMap).toEqual({});
    expect(cache.extras).toEqual({});
  });

  it('loads a well-formed cache', async () => {
    const path = join(dir, 'cache.json');
    const payload = {
      version: 1,
      generatedAt: '2026-04-29T00:00:00.000Z',
      proEnrichmentMap: {
        '68781': {
          nationalcode: 'JPN',
          sortTitleKo: '아이도루',
          sortSongKo: null,
          subTitle: null,
          publishdate: '2023-05-24',
          lastSeen: '2026-04-29T00:00:00.000Z',
        },
      },
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');
    const cache = await loadCache(path);
    expect(cache.proEnrichmentMap['68781']?.sortTitleKo).toBe('아이도루');
    expect(cache.proEnrichmentMap['68781']?.lastSeen).toBe('2026-04-29T00:00:00.000Z');
  });

  it('recovers from a malformed JSON file by returning an empty cache (and warns)', async () => {
    const path = join(dir, 'cache.json');
    await writeFile(path, '{not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cache = await loadCache(path);
      expect(cache.proEnrichmentMap).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('recovers from a non-object root by returning an empty cache (and warns)', async () => {
    const path = join(dir, 'cache.json');
    await writeFile(path, '[]', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cache = await loadCache(path);
      expect(cache.proEnrichmentMap).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('loads PR-2 artistNationalityMap as a typed top-level field', async () => {
    const path = join(dir, 'cache.json');
    const payload = {
      version: 1,
      generatedAt: '2026-04-29T00:00:00.000Z',
      proEnrichmentMap: {},
      artistNationalityMap: {
        yoasobi: {
          code: 'JPN',
          votes: { JPN: 12, KOR: 0, ENG: 0 },
          lastSeen: '2026-04-29T00:00:00.000Z',
        },
      },
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');
    const cache = await loadCache(path);
    expect(cache.artistNationalityMap.yoasobi?.code).toBe('JPN');
    expect(cache.artistNationalityMap.yoasobi?.votes).toEqual({ JPN: 12, KOR: 0, ENG: 0 });
    expect(cache.artistNationalityMap.yoasobi?.lastSeen).toBe('2026-04-29T00:00:00.000Z');
  });

  it('preserves unrecognized top-level fields into extras', async () => {
    const path = join(dir, 'cache.json');
    const payload = {
      version: 1,
      generatedAt: '2026-04-29T00:00:00.000Z',
      proEnrichmentMap: {},
      artistNationalityMap: {},
      futureField: { foo: 'bar' },
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');
    const cache = await loadCache(path);
    expect(cache.extras.futureField).toEqual({ foo: 'bar' });
  });

  it('skips entries missing lastSeen (graceful schema-drift recovery)', async () => {
    const path = join(dir, 'cache.json');
    const payload = {
      version: 1,
      generatedAt: '2026-04-29T00:00:00.000Z',
      proEnrichmentMap: {
        '111': { nationalcode: 'JPN', sortTitleKo: 'a', lastSeen: '2026-01-01T00:00:00.000Z' },
        '222': { nationalcode: 'JPN', sortTitleKo: 'b' /* no lastSeen */ },
      },
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');
    const cache = await loadCache(path);
    expect(cache.proEnrichmentMap['111']).toBeDefined();
    expect(cache.proEnrichmentMap['222']).toBeUndefined();
  });
});

describe('saveCache', () => {
  it('writes atomically (round-trip) and pretty-prints the JSON', async () => {
    const path = join(dir, 'cache.json');
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.proEnrichmentMap['1'] = {
      nationalcode: 'JPN',
      sortTitleKo: 'a',
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    await saveCache(path, cache);
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe(CACHE_VERSION);
    expect(parsed.generatedAt).toBe('2026-04-29T00:00:00.000Z');
    expect(parsed.proEnrichmentMap['1'].sortTitleKo).toBe('a');
    // pretty-printed (contains a newline + indent)
    expect(text).toContain('\n');
  });

  it('preserves extras (forward-compat round-trip for unknown future fields)', async () => {
    const path = join(dir, 'cache.json');
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.extras.futureField = { foo: 'bar' };
    await saveCache(path, cache);

    const reloaded = await loadCache(path);
    expect(reloaded.extras.futureField).toEqual({ foo: 'bar' });
  });

  it('round-trips artistNationalityMap as a typed field (not via extras)', async () => {
    const path = join(dir, 'cache.json');
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.artistNationalityMap.yoasobi = {
      code: 'JPN',
      votes: { JPN: 5, KOR: 0, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    await saveCache(path, cache);

    const reloaded = await loadCache(path);
    expect(reloaded.artistNationalityMap.yoasobi?.code).toBe('JPN');
    expect(reloaded.artistNationalityMap.yoasobi?.votes.JPN).toBe(5);
  });

  it('does not let extras shadow the PR-1 fields', async () => {
    const path = join(dir, 'cache.json');
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    // Hostile: a future field accidentally collides with a PR-1 field.
    cache.extras.proEnrichmentMap = { hijack: 'attempt' } as unknown;
    cache.proEnrichmentMap['1'] = {
      nationalcode: 'JPN',
      sortTitleKo: 'real',
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    await saveCache(path, cache);
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    expect(parsed.proEnrichmentMap['1'].sortTitleKo).toBe('real');
    expect(parsed.proEnrichmentMap.hijack).toBeUndefined();
  });
});

describe('isFresh', () => {
  const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
  cache.proEnrichmentMap['1'] = {
    nationalcode: 'JPN',
    sortTitleKo: null,
    sortSongKo: null,
    subTitle: null,
    publishdate: null,
    lastSeen: '2026-04-29T00:00:00.000Z',
  };

  it('returns false for a missing pro', () => {
    expect(isFresh(cache, 'unknown', new Date('2026-04-29T00:00:00.000Z'))).toBe(false);
  });

  it('returns true when lastSeen is within 90 days', () => {
    const now = new Date('2026-05-29T00:00:00.000Z'); // 30 days later
    expect(isFresh(cache, '1', now)).toBe(true);
  });

  it('returns false when lastSeen is older than 90 days', () => {
    const now = new Date(new Date('2026-04-29T00:00:00.000Z').getTime() + CACHE_STALENESS_MS + 1);
    expect(isFresh(cache, '1', now)).toBe(false);
  });

  it('returns false on an unparseable lastSeen', () => {
    const c = emptyCache();
    c.proEnrichmentMap['1'] = {
      nationalcode: null,
      sortTitleKo: null,
      sortSongKo: null,
      subTitle: null,
      publishdate: null,
      lastSeen: 'not-a-date',
    };
    expect(isFresh(c, '1')).toBe(false);
  });
});

describe('isBootstrapFresh — keyed off bootstrappedAt, NOT generatedAt', () => {
  it('returns false on a PR-1-shape cache (no bootstrappedAt) regardless of generatedAt freshness', async () => {
    // PR-1 cache with a recent generatedAt but no bootstrappedAt should NOT
    // be considered fresh — translit/artist-scan refreshes must not mask a
    // missing chart bootstrap.
    const path = join(dir, 'cache.json');
    const recentNow = new Date('2026-04-29T00:00:00.000Z').toISOString();
    const payload = {
      version: 1,
      generatedAt: recentNow,
      proEnrichmentMap: {},
      // no bootstrappedAt, no artistNationalityMap
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');
    const cache = await loadCache(path);
    expect(cache.bootstrappedAt).toBeUndefined();
    expect(isBootstrapFresh(cache, new Date('2026-04-29T00:00:00.000Z'))).toBe(false);
  });

  it('returns true after bootstrap stamps bootstrappedAt; false 8 days later', () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.bootstrappedAt = '2026-04-29T00:00:00.000Z';
    // Same-day -> fresh.
    expect(isBootstrapFresh(cache, new Date('2026-04-29T00:00:00.000Z'))).toBe(true);
    // 1 day later -> still fresh.
    expect(isBootstrapFresh(cache, new Date('2026-04-30T00:00:00.000Z'))).toBe(true);
    // 8 days later (TTL=7d) -> stale.
    expect(isBootstrapFresh(cache, new Date('2026-05-07T00:00:00.001Z'))).toBe(false);
  });

  it('does NOT consult generatedAt — translit-only refresh must not mark bootstrap fresh', () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    // generatedAt is recent (translit ran today)
    cache.generatedAt = '2026-04-29T00:00:00.000Z';
    // but bootstrappedAt is from 30 days ago (well past 7-day TTL)
    cache.bootstrappedAt = '2026-03-30T00:00:00.000Z';
    expect(isBootstrapFresh(cache, new Date('2026-04-29T00:00:00.000Z'))).toBe(false);
  });

  it('returns false on unparseable bootstrappedAt', () => {
    const cache = emptyCache();
    cache.bootstrappedAt = 'not-a-date';
    expect(isBootstrapFresh(cache)).toBe(false);
  });

  it('honors a custom ttlMs override (used by tests)', () => {
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.bootstrappedAt = '2026-04-28T00:00:00.000Z';
    // TTL=7d -> fresh, but with TTL=12h it's stale.
    expect(isBootstrapFresh(cache, new Date('2026-04-29T00:00:00.000Z'))).toBe(true);
    expect(isBootstrapFresh(cache, new Date('2026-04-29T00:00:00.000Z'), 12 * 60 * 60 * 1000)).toBe(
      false,
    );
    // Sanity: TTL constant matches BOOTSTRAP_STALENESS_MS.
    expect(BOOTSTRAP_STALENESS_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('CACHE_VERSION — v1→v2 migration round-trip', () => {
  it('loads a version: 1 cache and rewrites it as version: 2 (loader is structurally tolerant)', async () => {
    const path = join(dir, 'cache.json');
    const payload = {
      version: 1,
      generatedAt: '2026-04-29T00:00:00.000Z',
      proEnrichmentMap: {
        '68781': {
          nationalcode: 'JPN',
          sortTitleKo: '아이도루',
          sortSongKo: null,
          subTitle: null,
          publishdate: '2023-05-24',
          lastSeen: '2026-04-29T00:00:00.000Z',
        },
      },
      // PR-1-shape: no artistNationalityMap, no bootstrappedAt.
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');

    // Loader tolerates v1 — succeeds and exposes version=1 in memory.
    const loaded = await loadCache(path);
    expect(loaded.version).toBe(1);
    expect(loaded.proEnrichmentMap['68781']?.sortTitleKo).toBe('아이도루');
    expect(loaded.bootstrappedAt).toBeUndefined();
    expect(loaded.artistNationalityMap).toEqual({});

    // The next save (which the crawler will do via emptyCache().version=2 or
    // by mutating loaded.version) writes version=2. We simulate the crawler's
    // behavior: bump version on save.
    loaded.version = CACHE_VERSION;
    await saveCache(path, loaded);

    const reloadText = await readFile(path, 'utf8');
    const reloadJson = JSON.parse(reloadText);
    expect(reloadJson.version).toBe(2);
    expect(CACHE_VERSION).toBe(2);
    // Migration is non-destructive — PR-1 data round-trips.
    expect(reloadJson.proEnrichmentMap['68781'].sortTitleKo).toBe('아이도루');
  });
});
