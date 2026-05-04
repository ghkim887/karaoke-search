import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CrawlOptions, Crawler } from '../src/adapters/index.js';
import { runPipeline } from '../src/pipeline.js';

/**
 * Integration tests for `runPipeline` covering the alias-resolution stage's
 * effect on Tier B clustering. Spec: 2026-05-04-artist-alias-dedup-design.md.
 */

function record(over: Partial<SongRecord>): SongRecord {
  return {
    id: 'blog-1-0',
    source_url: 'https://example.test/1',
    title_primary: 'Some Song',
    title_ko: null,
    artist_primary: 'Some Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-05-04T10:00:00Z',
    ...over,
  };
}

function fixedAdapter(name: string, records: SongRecord[]): Crawler {
  return {
    name,
    async *crawl(_opts?: CrawlOptions): AsyncIterable<SongRecord> {
      for (const r of records) yield r;
    },
  };
}

describe('runPipeline — alias resolution + Tier B integration', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'pipeline-aliases-'));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('Tier B merges pipe-form blog record + bare TJ record once aliases are resolved', async () => {
    const blog = record({
      id: 'blog-100-0',
      source_url: 'https://blog.test/100',
      title_primary: '夜に駆ける',
      artist_primary: 'YOASOBI｜요아소비',
      categories: ['jpop'],
      karaoke_numbers: { tj: null, ky: null, joysound: '600001' },
    });
    const tj = record({
      id: 'tj-200',
      source_url: 'https://tj.test/200',
      title_primary: '夜に駆ける',
      artist_primary: '요아소비',
      categories: ['jpop'],
      karaoke_numbers: { tj: '99999', ky: null, joysound: null },
    });

    const outPath = join(outDir, 'songs.json');
    const result = await runPipeline({
      adapters: [fixedAdapter('blog', [blog]), fixedAdapter('tj', [tj])],
      outPath,
    });

    expect(result.written).toBe(1);
    const json = JSON.parse(await readFile(outPath, 'utf8')) as SongRecord[];
    expect(json).toHaveLength(1);
    // Tier B fired post-alias-resolution: vendor numbers union from both records.
    expect(json[0]?.karaoke_numbers.tj).toBe('99999');
    expect(json[0]?.karaoke_numbers.joysound).toBe('600001');
    // Canonical retained, alias survives.
    expect(json[0]?.artist_primary).toBe('YOASOBI');
    expect(json[0]?.artist_aliases).toContain('요아소비');
  });

  it('keeps bare record separate when its alias collides with two distinct canonicals', async () => {
    const aimerVisual = record({
      id: 'blog-1000-0',
      source_url: 'https://blog.test/1000',
      title_primary: 'Visual A',
      artist_primary: 'Aimer (Visual Artist)｜Aimer',
      categories: ['jpop'],
      karaoke_numbers: { tj: null, ky: null, joysound: '700001' },
    });
    const aimerSinger = record({
      id: 'blog-2000-0',
      source_url: 'https://blog.test/2000',
      title_primary: 'Singer S',
      artist_primary: 'Aimer (Singer)｜Aimer',
      categories: ['jpop'],
      karaoke_numbers: { tj: null, ky: null, joysound: '700002' },
    });
    const bareAimer = record({
      id: 'tj-9999',
      source_url: 'https://tj.test/9999',
      title_primary: 'Some Track',
      artist_primary: 'Aimer',
      categories: ['jpop'],
      karaoke_numbers: { tj: '88888', ky: null, joysound: null },
    });

    const outPath = join(outDir, 'songs.json');
    const result = await runPipeline({
      adapters: [fixedAdapter('blog', [aimerVisual, aimerSinger]), fixedAdapter('tj', [bareAimer])],
      outPath,
    });

    // 3 distinct titles → 3 records survive (no merge fires; collision blocks
    // the bare-record re-key, and the two pipe-form records have different
    // titles so Tier B doesn't pull them together either).
    expect(result.written).toBe(3);
    expect(result.aliasConflicts.length).toBeGreaterThanOrEqual(1);
    const collision = result.aliasConflicts.find((w) => w.canonicals.length === 2);
    expect(collision?.alias).toBe('Aimer');
  });

  it('writes aliasConflicts summary block to the conflicts-out JSON', async () => {
    const a = record({
      id: 'blog-1000-0',
      source_url: 'https://blog.test/1000',
      title_primary: 'Foo',
      artist_primary: 'Aimer (Visual Artist)｜Aimer',
      categories: ['jpop'],
    });
    const b = record({
      id: 'blog-2000-0',
      source_url: 'https://blog.test/2000',
      title_primary: 'Bar',
      artist_primary: 'Aimer (Singer)｜Aimer',
      categories: ['jpop'],
    });

    const outPath = join(outDir, 'songs.json');
    const conflictsOutPath = join(outDir, 'conflicts.json');
    await runPipeline({
      adapters: [fixedAdapter('blog', [a, b])],
      outPath,
      conflictsOutPath,
    });

    const summary = JSON.parse(await readFile(conflictsOutPath, 'utf8'));
    expect(summary).toHaveProperty('aliasConflicts');
    expect(summary.aliasConflicts).toHaveProperty('total');
    expect(summary.aliasConflicts).toHaveProperty('sample');
    expect(summary.aliasConflicts.total).toBeGreaterThanOrEqual(1);
  });
});
