import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_STALENESS_MS,
  CACHE_VERSION,
  emptyCache,
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

  it('preserves PR-2 forward-compat fields (artistNationalityMap) into extras', async () => {
    const path = join(dir, 'cache.json');
    const payload = {
      version: 1,
      generatedAt: '2026-04-29T00:00:00.000Z',
      proEnrichmentMap: {},
      artistNationalityMap: { yoasobi: { code: 'JPN', votes: { JPN: 12 } } },
    };
    await writeFile(path, JSON.stringify(payload), 'utf8');
    const cache = await loadCache(path);
    expect(cache.extras.artistNationalityMap).toEqual({
      yoasobi: { code: 'JPN', votes: { JPN: 12 } },
    });
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

  it('preserves extras (forward-compat round-trip)', async () => {
    const path = join(dir, 'cache.json');
    const cache = emptyCache(new Date('2026-04-29T00:00:00.000Z'));
    cache.extras.artistNationalityMap = { yoasobi: { code: 'JPN' } };
    await saveCache(path, cache);

    const reloaded = await loadCache(path);
    expect(reloaded.extras.artistNationalityMap).toEqual({ yoasobi: { code: 'JPN' } });
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
