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
