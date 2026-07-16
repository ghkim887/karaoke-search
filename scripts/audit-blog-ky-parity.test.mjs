import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildJsonl, computeParity, parseArgs, runAudit } from './audit-blog-ky-parity.mjs';

function rec(over) {
  return {
    id: 'blog-1-0',
    title_primary: 'T',
    artist_primary: 'A',
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    ...over,
  };
}

describe('computeParity', () => {
  it('counts live KY coverage and residual blog KY claims separately', () => {
    const records = [
      rec({ id: 'ky-100', karaoke_numbers: { tj: null, ky: '100', joysound: null } }),
      rec({ id: 'ky-101', karaoke_numbers: { tj: null, ky: '101', joysound: null } }),
      // Residual blog rows still carrying a ky number (uncovered by live KY).
      rec({ id: 'blog-9-0', karaoke_numbers: { tj: null, ky: '900', joysound: null } }),
      rec({ id: 'blog-9-1', karaoke_numbers: { tj: null, ky: '901', joysound: null } }),
      // A tj-* record with no ky — ignored.
      rec({ id: 'tj-5', karaoke_numbers: { tj: '5', ky: null, joysound: null } }),
    ];
    const { residuals, summary } = computeParity(records);
    expect(summary).toEqual({ scanned: 5, liveKyCount: 2, blogResidualKyCount: 2 });
    expect(residuals.map((r) => r.ky)).toEqual(['900', '901']);
    expect(residuals[0]).toMatchObject({ ky: '900', id: 'blog-9-0' });
  });

  it('does not count ky on graduated (ky-*) or vendor records as residual', () => {
    const records = [
      rec({ id: 'ky-100', karaoke_numbers: { tj: null, ky: '100', joysound: null } }),
      // joysound-* record that happens to carry a ky (a merged cluster) — not
      // a standalone blog residual, so it is not counted as a blog claim.
      rec({ id: 'joysound-7', karaoke_numbers: { tj: null, ky: '200', joysound: '7' } }),
    ];
    const { summary } = computeParity(records);
    expect(summary.blogResidualKyCount).toBe(0);
    expect(summary.liveKyCount).toBe(1);
  });

  it('buildJsonl emits one compact object per residual', () => {
    const jsonl = buildJsonl([
      { ky: '900', id: 'blog-9-0', title_primary: 'T', artist_primary: 'A' },
    ]);
    expect(jsonl).toBe('{"ky":"900","id":"blog-9-0","title_primary":"T","artist_primary":"A"}');
  });
});

describe('parseArgs', () => {
  it('parses a positional corpus and --out', () => {
    expect(parseArgs(['corpus.json', '--out', 'd'])).toEqual({
      corpusPath: 'corpus.json',
      outDir: 'd',
      help: false,
    });
  });
  it('throws on unknown flags and extra args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow(/extra argument/);
  });
});

describe('runAudit', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ky-parity-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const silent = { log: () => {}, error: () => {} };

  it('returns 2 on a missing corpus', () => {
    expect(runAudit({ corpusPath: join(dir, 'nope.json'), outDir: dir, log: silent })).toBe(2);
  });

  it('writes the residuals JSONL and returns 0 (report-only)', () => {
    const corpusPath = join(dir, 'songs.json');
    writeFileSync(
      corpusPath,
      JSON.stringify([
        rec({ id: 'ky-100', karaoke_numbers: { tj: null, ky: '100', joysound: null } }),
        rec({ id: 'blog-9-0', karaoke_numbers: { tj: null, ky: '900', joysound: null } }),
      ]),
      'utf8',
    );
    const code = runAudit({ corpusPath, outDir: dir, log: silent });
    expect(code).toBe(0);
    const jsonl = readFileSync(join(dir, 'blog-ky-residuals.jsonl'), 'utf8').trim();
    expect(JSON.parse(jsonl)).toMatchObject({ ky: '900', id: 'blog-9-0' });
  });
});
