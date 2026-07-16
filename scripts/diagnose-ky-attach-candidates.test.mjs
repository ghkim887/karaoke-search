import { describe, expect, it } from 'vitest';
import { buildReport, loadDeps, parseArgs } from './diagnose-ky-attach-candidates.mjs';

const AT = '2026-07-16T00:00:00.000Z';
function rec(over) {
  return {
    id: 'x-0',
    source_url: 'https://x.test/0',
    title_primary: 'T',
    title_ko: null,
    artist_primary: 'A',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    crawled_at: AT,
    ...over,
  };
}

describe('parseArgs', () => {
  it('parses the paths and --samples', () => {
    expect(parseArgs(['--corpus', 'c', '--ky', 'k', '--out', 'o', '--samples', '3'])).toEqual({
      corpus: 'c',
      ky: 'k',
      out: 'o',
      auditCsv: null,
      samples: 3,
      help: false,
    });
  });
  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

// Smoke: run the REAL merger over a tiny corpus that reproduces the scale
// condition (JOYSOUND targets are non-singletons), then check the diagnostic
// classifies the three residual ky rows into unique / ambiguous / none.
describe('buildReport — smoke over the real merger', () => {
  it('classifies attach candidates and simulates the Plan A/C guards', async () => {
    const { mergeRecords, deps } = await loadDeps();

    const corpus = [
      // Target 1 made non-singleton by a blog row sharing its joysound number.
      rec({
        id: 'joysound-100',
        title_primary: 'この世の限り',
        artist_primary: '椎名林檎×斎藤ネコ+椎名純平',
        karaoke_numbers: { tj: null, ky: null, joysound: '100' },
      }),
      rec({
        id: 'blog-500-1',
        title_primary: 'この世の限り',
        artist_primary: '椎名林檎',
        karaoke_numbers: { tj: null, ky: null, joysound: '100' },
      }),
      // Two DIFFERENT JOYSOUND clusters that share the attach key (same title +
      // lead artist) — a cover collision → ambiguous. Each made non-singleton.
      rec({
        id: 'joysound-200',
        title_primary: 'はじまりはいつも雨',
        artist_primary: '槇原敬之',
        karaoke_numbers: { tj: null, ky: null, joysound: '200' },
      }),
      rec({
        id: 'blog-600-1',
        title_primary: 'はじまりはいつも雨',
        artist_primary: '槇原敬之',
        karaoke_numbers: { tj: null, ky: null, joysound: '200' },
      }),
      rec({
        id: 'joysound-201',
        title_primary: 'はじまりはいつも雨',
        artist_primary: '槇原敬之 with Band',
        karaoke_numbers: { tj: null, ky: null, joysound: '201' },
      }),
      rec({
        id: 'blog-601-1',
        title_primary: 'はじまりはいつも雨',
        artist_primary: '槇原敬之 with Band',
        karaoke_numbers: { tj: null, ky: null, joysound: '201' },
      }),
    ];
    const ky = [
      rec({
        id: 'ky-1',
        title_primary: 'この世の限り',
        artist_primary: '椎名林檎,椎名純平',
        karaoke_numbers: { tj: null, ky: '1', joysound: null },
      }),
      rec({
        id: 'ky-2',
        title_primary: 'はじまりはいつも雨',
        artist_primary: '槇原敬之',
        karaoke_numbers: { tj: null, ky: '2', joysound: null },
      }),
      rec({
        id: 'ky-3',
        title_primary: '存在しない曲',
        artist_primary: '無名歌手',
        karaoke_numbers: { tj: null, ky: '3', joysound: null },
      }),
    ];

    const { records: merged } = mergeRecords([...corpus, ...ky]);
    const report = buildReport(corpus, ky, merged, deps, 5);

    // All three ky rows stay residual (their JOYSOUND targets are non-singletons
    // → Tier C/D never groups them). This IS the confirmed scale blocker.
    expect(report.merged.residualJoylessKy).toBe(3);
    expect(report.candidateBuckets).toEqual({ none: 1, unique: 1, ambiguous: 1 });
    // Plan A would merge exactly the unique + no-conflict row (ky-1).
    expect(report.planA.expectedMerges).toBe(1);
    // Plan C's stronger guard also passes ky-1 (stripped-title exact).
    expect(report.planC.uniquePassGuard).toBe(1);
    // The candidate targets are all non-singletons — the root cause, quantified.
    expect(report.hypothesis_nonsingleton.ratio).toBe(1);
    // The unique-bucket sample carries the fields the owner eyeballs.
    const u = report.samples.unique[0];
    expect(u.ky_id).toBe('ky-1');
    expect(u.cand_count).toBe(1);
    expect(u.cand_nonsingleton).toBe(true);
    expect(u.no_conflict).toBe(true);
    expect(u.candidates[0].joysound).toBe('100');
  });
});
