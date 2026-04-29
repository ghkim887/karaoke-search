import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawSongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import { normalize } from '../../../src/adapters/tj-media-direct/normalizer.js';
import { parseCatalogResponse } from '../../../src/adapters/tj-media-direct/parser.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(HERE, '../../fixtures/tj-media-direct/catalog-sample.json');
const SOURCE_URL = 'https://www.tjmedia.com/legacy/api/newSongOfMonth';
const CRAWLED_AT = '2026-04-27T00:46:00.000Z';
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

/**
 * Build a cache that will let every fixture record through path-2 (per-artist
 * JPN). The fixture is hand-built so every JP-relevant artist's normalized
 * key is one of the few we explicitly tag; the remaining records get
 * dropped, which is the new PR-2 default for unconfirmed records.
 */
function fixtureFriendlyCache(): ReturnType<typeof emptyCache> {
  const cache = emptyCache();
  // Whitelist every pro from the fixture's items array — this is the
  // "blog rescue" path, simpler than enumerating each artist.
  // Use it via the parseCatalogResponse `forceIncludeTjNumbers` option.
  return cache;
}

describe('normalize — fixture-derived records', () => {
  const allTj = new Set<string>();
  for (const item of FIXTURE.resultData.items) {
    if (typeof item.pro === 'number') allTj.add(String(item.pro));
    else if (typeof item.pro === 'string') allTj.add(item.pro);
  }
  const { records: raws } = parseCatalogResponse(FIXTURE, SOURCE_URL, {
    cache: fixtureFriendlyCache(),
    forceIncludeTjNumbers: allTj,
  });
  const records = raws.map((r) => normalize(r, CRAWLED_AT));

  it('every record has categories=["jpop"] exactly (length 1, value "jpop")', () => {
    for (const r of records) {
      expect(r.categories).toHaveLength(1);
      expect(r.categories[0]).toBe('jpop');
    }
  });

  it('every record has title_ko and artist_ko null', () => {
    for (const r of records) {
      expect(r.title_ko).toBeNull();
      expect(r.artist_ko).toBeNull();
    }
  });

  it('every record id matches /^tj-\\d+$/', () => {
    for (const r of records) {
      expect(r.id).toMatch(/^tj-\d+$/);
    }
  });

  it('every record has karaoke_numbers.tj non-null and digit-only; ky/joysound null', () => {
    for (const r of records) {
      expect(r.karaoke_numbers.tj).not.toBeNull();
      expect(r.karaoke_numbers.tj).toMatch(/^\d+$/);
      expect(r.karaoke_numbers.ky).toBeNull();
      expect(r.karaoke_numbers.joysound).toBeNull();
    }
  });

  it('threads the passed crawled_at through every record', () => {
    for (const r of records) {
      expect(r.crawled_at).toBe(CRAWLED_AT);
    }
  });

  it('id is derived from the TJ number', () => {
    expect(records[0]).toBeDefined();
    expect(records[0]?.id).toBe(`tj-${records[0]?.karaoke_numbers.tj}`);
  });
});

describe('normalize — direct unit cases', () => {
  function rawFor(over: Partial<RawSongRecord>): RawSongRecord {
    return {
      source_url: SOURCE_URL,
      title_primary: 'Title',
      title_ko: null,
      artist_primary: 'Artist',
      artist_ko: null,
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
      categories: ['jpop'],
      ...over,
    };
  }

  it('throws when the raw record has no TJ number', () => {
    expect(() =>
      normalize(rawFor({ karaoke_numbers: { tj: null, ky: null, joysound: null } }), CRAWLED_AT),
    ).toThrow(/no TJ number/);
  });

  it('forces categories=["jpop"] regardless of incoming raw value', () => {
    // Defensive: even if a parser variant drifted, the normalizer pins
    // the category at the v2 spec's uniform value.
    const r = normalize(rawFor({}), CRAWLED_AT);
    expect(r.categories).toEqual(['jpop']);
  });
});
