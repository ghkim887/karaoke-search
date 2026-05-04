import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { buildIndex } from './search.js';

const fixtureUrl = new URL(
  '../../../../packages/crawler/test/fixtures/songs.sample.json',
  import.meta.url,
);
const records = JSON.parse(readFileSync(fileURLToPath(fixtureUrl), 'utf8')) as SongRecord[];

describe('search index (sample fixture)', () => {
  it('matches Japanese-script artist query "結束バンド"', () => {
    const index = buildIndex(records);
    const hits = index.search('結束バンド');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const top = hits[0];
    expect(top).toBeDefined();
    expect(['sample-0', 'sample-1']).toContain(top?.id);
  });

  it('casefolds Latin queries: "radwimps" matches "RADWIMPS"', () => {
    const index = buildIndex(records);
    const hits = index.search('radwimps');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ids = hits.map((h) => h.id);
    expect(ids.some((id) => id === 'sample-4' || id === 'sample-5')).toBe(true);
  });

  it('prefix-matches "DECO" against "DECO*27"', () => {
    const index = buildIndex(records);
    const hits = index.search('DECO');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const ids = hits.map((h) => h.id);
    expect(ids.some((id) => id === 'sample-8' || id === 'sample-9')).toBe(true);
  });
});

describe('search index — artist_aliases (spec 2026-05-04)', () => {
  function makeRecord(over: Partial<SongRecord>): SongRecord {
    return {
      id: 'alias-0',
      source_url: 'https://example.test/0',
      title_primary: 'Some Song',
      title_ko: null,
      artist_primary: 'ずっと真夜中でいいのに。',
      artist_ko: null,
      karaoke_numbers: { tj: null, ky: null, joysound: null },
      categories: ['jpop'],
      crawled_at: '2026-05-04T00:00:00Z',
      ...over,
    };
  }

  it('finds a record by its Latin alias when artist_aliases includes it ("ZUTOMAYO")', () => {
    const r = makeRecord({
      id: 'alias-1',
      artist_primary: 'ずっと真夜中でいいのに。',
      artist_aliases: ['ZUTOMAYO'],
    });
    const index = buildIndex([r]);
    const hits = index.search('ZUTOMAYO');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.id)).toContain('alias-1');
  });

  it('still finds the same record by its Japanese canonical name', () => {
    const r = makeRecord({
      id: 'alias-2',
      artist_primary: 'ずっと真夜中でいいのに。',
      artist_aliases: ['ZUTOMAYO'],
    });
    const index = buildIndex([r]);
    const hits = index.search('ずっと');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.id)).toContain('alias-2');
  });

  it('finds a record via a multi-character alias ("40meterP")', () => {
    const r = makeRecord({
      id: 'alias-3',
      artist_primary: '40mP',
      artist_aliases: ['40meterP'],
    });
    const index = buildIndex([r]);
    const hits = index.search('40meterP');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.id)).toContain('alias-3');
  });

  it('does NOT find a record by an unrelated alias when its artist_aliases is empty', () => {
    const r = makeRecord({
      id: 'alias-4',
      artist_primary: 'BUMP OF CHICKEN',
      // No artist_aliases.
    });
    const index = buildIndex([r]);
    const hits = index.search('Spitz');
    // No record carries the "Spitz" alias here — should NOT match.
    expect(hits.map((h) => h.id)).not.toContain('alias-4');
  });
});
