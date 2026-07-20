import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeStats,
  conservationHolds,
  hasKy,
  hasTj,
  isBlog,
  isOfflineSubsetMember,
  parseArgs,
  partitionOfflineSubset,
  runExtractOfflineSubset,
} from './extract-offline-subset.mjs';

const rec = (id, nums) => ({
  id,
  title_primary: id,
  artist_primary: 'A',
  karaoke_numbers: { tj: null, ky: null, joysound: null, ...nums },
});

describe('parseArgs', () => {
  it('parses --corpus and --out', () => {
    expect(parseArgs(['--corpus', 'full.json', '--out', 'songs.json'])).toEqual({
      corpus: 'full.json',
      out: 'songs.json',
      help: false,
    });
  });
  it('throws when a required flag is missing', () => {
    expect(() => parseArgs(['--corpus', 'full.json'])).toThrow(/missing required flag/);
  });
  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
  it('throws when a flag is given no value', () => {
    expect(() => parseArgs(['--corpus'])).toThrow(/--corpus requires a path argument/);
  });
});

describe('membership predicate — the three accept paths', () => {
  it('accepts a record with a TJ number', () => {
    expect(hasTj(rec('tj-1', { tj: '100' }))).toBe(true);
    expect(isOfflineSubsetMember(rec('tj-1', { tj: '100' }))).toBe(true);
  });
  it('accepts a record with a KY number', () => {
    expect(hasKy(rec('ky-1', { ky: '200' }))).toBe(true);
    expect(isOfflineSubsetMember(rec('ky-1', { ky: '200' }))).toBe(true);
  });
  it('accepts a blog-* id even with no tj/ky number', () => {
    expect(isBlog(rec('blog-9-1', { joysound: '300' }))).toBe(true);
    expect(isOfflineSubsetMember(rec('blog-9-1', { joysound: '300' }))).toBe(true);
  });
  it('rejects a JOYSOUND-only record with a non-blog id', () => {
    const joyOnly = rec('joy-1', { joysound: '300' });
    expect(hasTj(joyOnly)).toBe(false);
    expect(hasKy(joyOnly)).toBe(false);
    expect(isBlog(joyOnly)).toBe(false);
    expect(isOfflineSubsetMember(joyOnly)).toBe(false);
  });
  it('rejects a numberless non-blog record', () => {
    expect(isOfflineSubsetMember(rec('other-1', {}))).toBe(false);
  });
});

describe('partitionOfflineSubset', () => {
  it('keeps members, drops non-members, and preserves input order', () => {
    const records = [
      rec('tj-1', { tj: '1' }),
      rec('joy-1', { joysound: '2' }), // dropped (joysound-only, non-blog)
      rec('ky-1', { ky: '3' }),
      rec('blog-5-1', { joysound: '4' }), // kept (blog id)
      rec('none-1', {}), // dropped (numberless, non-blog)
    ];
    const { kept, dropped } = partitionOfflineSubset(records);
    expect(kept.map((r) => r.id)).toEqual(['tj-1', 'ky-1', 'blog-5-1']);
    expect(dropped.map((r) => r.id)).toEqual(['joy-1', 'none-1']);
  });
});

describe('computeStats — overlapping per-path counts', () => {
  it('counts each path independently (overlap allowed) and blog joysound-only', () => {
    const kept = [
      rec('tj-1', { tj: '1' }), // tj
      rec('blog-2-1', { tj: '2' }), // tj AND blog
      rec('ky-1', { ky: '3' }), // ky
      rec('blog-3-1', { joysound: '9' }), // blog joysound-only
      rec('blog-4-1', {}), // blog, numberless
    ];
    // Sanity: computeStats is over the KEPT set (all members here).
    expect(computeStats(kept)).toEqual({
      total: 5,
      tj: 2, // tj-1, blog-2-1
      ky: 1, // ky-1
      blog: 3, // blog-2-1, blog-3-1, blog-4-1
      blogJoyOnly: 1, // blog-3-1 only (blog-2-1 has tj; blog-4-1 has no joysound)
    });
  });
});

describe('conservationHolds', () => {
  it('holds when input === kept + dropped', () => {
    expect(conservationHolds(10, 7, 3)).toBe(true);
  });
  it('fails on mismatch', () => {
    expect(conservationHolds(10, 7, 2)).toBe(false);
  });
});

describe('runExtractOfflineSubset (integration)', () => {
  let dir;
  const silent = { log: () => {}, error: () => {} };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'extract-offline-'));
  });

  it('writes only the members, in input order, with the canonical byte shape', () => {
    const corpusPath = join(dir, 'full.json');
    const outPath = join(dir, 'songs.json');
    const input = [
      rec('tj-1', { tj: '1' }),
      rec('joy-1', { joysound: '2' }),
      rec('ky-1', { ky: '3' }),
      rec('blog-5-1', { joysound: '4' }),
    ];
    writeFileSync(corpusPath, JSON.stringify(input), 'utf-8');

    const code = runExtractOfflineSubset({ corpusPath, outPath, log: silent });

    expect(code).toBe(0);
    const kept = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(kept.map((r) => r.id)).toEqual(['tj-1', 'ky-1', 'blog-5-1']);
    // canonical byte shape: indent=2 + trailing newline, no leftover .tmp
    expect(readFileSync(outPath, 'utf-8')).toBe(`${JSON.stringify(kept, null, 2)}\n`);
    expect(existsSync(`${outPath}.tmp`)).toBe(false);
  });

  it('is byte-idempotent when re-run on the same input', () => {
    const corpusPath = join(dir, 'full.json');
    const outPath = join(dir, 'songs.json');
    writeFileSync(
      corpusPath,
      JSON.stringify([rec('tj-1', { tj: '1' }), rec('joy-1', { joysound: '2' })]),
      'utf-8',
    );

    expect(runExtractOfflineSubset({ corpusPath, outPath, log: silent })).toBe(0);
    const first = readFileSync(outPath, 'utf-8');
    expect(runExtractOfflineSubset({ corpusPath, outPath, log: silent })).toBe(0);
    const second = readFileSync(outPath, 'utf-8');
    expect(second).toBe(first);
  });

  it('returns exit 2 when the input corpus is missing', () => {
    const code = runExtractOfflineSubset({
      corpusPath: join(dir, 'nope.json'),
      outPath: join(dir, 'songs.json'),
      log: silent,
    });
    expect(code).toBe(2);
  });

  it('returns exit 2 when the input is not a JSON array', () => {
    const corpusPath = join(dir, 'obj.json');
    writeFileSync(corpusPath, JSON.stringify({ not: 'an array' }), 'utf-8');
    const code = runExtractOfflineSubset({
      corpusPath,
      outPath: join(dir, 'songs.json'),
      log: silent,
    });
    expect(code).toBe(2);
  });
});
