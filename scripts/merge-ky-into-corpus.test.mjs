import { describe, expect, it } from 'vitest';
import { buildDriftReport, loadDist, parseArgs, runMergeDriver } from './merge-ky-into-corpus.mjs';

const AT = '2026-07-16T00:00:00.000Z';
function rec(over) {
  return {
    id: 'tj-0',
    source_url: 'https://tj.test/0',
    title_primary: 'T',
    title_ko: null,
    artist_primary: 'A',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    crawled_at: AT,
    ...over,
  };
}

describe('buildDriftReport — classification of all categories', () => {
  // Corpus (pre-merge full corpus).
  const corpus = [
    rec({ id: 'tj-1', karaoke_numbers: { tj: '1', ky: null, joysound: null } }), // unchanged
    rec({ id: 'tj-2', karaoke_numbers: { tj: '2', ky: null, joysound: null } }), // field-changed
    rec({ id: 'tj-3', karaoke_numbers: { tj: '3', ky: null, joysound: null } }), // merged-into-existing
    rec({ id: 'blog-9-1', karaoke_numbers: { tj: null, ky: '600', joysound: null } }), // graduated
    rec({ id: 'blog-9-2', karaoke_numbers: { tj: null, ky: null, joysound: null } }), // unexpected disappearance
  ];
  // KY smoke input.
  const ky = [
    rec({ id: 'ky-500', karaoke_numbers: { tj: null, ky: '500', joysound: null } }), // absorbed by tj-3
    rec({ id: 'ky-600', karaoke_numbers: { tj: null, ky: '600', joysound: null } }), // graduation target
    rec({ id: 'ky-700', karaoke_numbers: { tj: null, ky: '700', joysound: null } }), // new-standalone
  ];
  // Simulated merge output (what mergeRecords WOULD produce for this scenario).
  const out = [
    rec({ id: 'tj-1', karaoke_numbers: { tj: '1', ky: null, joysound: null } }), // identical → unchanged
    rec({
      id: 'tj-2',
      karaoke_numbers: { tj: '2', ky: null, joysound: null },
      crawled_at: '2026-07-17T00:00:00.000Z',
    }), // field-changed (crawled_at)
    rec({ id: 'tj-3', karaoke_numbers: { tj: '3', ky: '500', joysound: null } }), // gained ky 500
    rec({ id: 'ky-600', karaoke_numbers: { tj: null, ky: '600', joysound: null } }), // blog-9-1 graduated here
    rec({ id: 'ky-700', karaoke_numbers: { tj: null, ky: '700', joysound: null } }), // new-standalone
    // blog-9-1 absent (graduated), blog-9-2 absent (unexpected), ky-500 absent (absorbed).
  ];
  const conflicts = [{ field: 'ky', cluster_key: 'k', values: [], winner: '500' }];
  const report = buildDriftReport(corpus, ky, out, conflicts);

  it('totals + collapse', () => {
    expect(report.totals).toEqual({ corpusIn: 5, kyIn: 3, out: 5, collapsed: 3 });
  });
  it('① unchanged', () => {
    expect(report.unchanged.count).toBe(1);
  });
  it('② field-changed with per-field counts', () => {
    expect(report.fieldChanged.count).toBe(1);
    expect(report.fieldChanged.byField).toEqual({ crawled_at: 1 });
    expect(report.fieldChanged.sample[0]).toEqual({ id: 'tj-2', fields: ['crawled_at'] });
  });
  it('③ graduated (blog-*→ky-*) full list', () => {
    expect(report.graduated).toEqual({ count: 1, entries: [{ from: 'blog-9-1', to: 'ky-600' }] });
  });
  it('④ merged-into-existing', () => {
    expect(report.mergedIntoExisting.count).toBe(1);
    expect(report.mergedIntoExisting.sample[0]).toEqual({ id: 'tj-3', kyGained: '500' });
  });
  it('⑤ new-standalone', () => {
    expect(report.newStandalone.count).toBe(1);
    expect(report.newStandalone.sample).toContain('ky-700');
  });
  it('⑥ unexpected (full list) — corpus id disappeared without graduation', () => {
    expect(report.unexpected.count).toBe(1);
    expect(report.unexpected.entries[0]).toMatchObject({
      id: 'blog-9-2',
      reason: 'corpus-id-disappeared-without-graduation',
    });
  });
  it('⑦ conflicts summary', () => {
    expect(report.conflicts.total).toBe(1);
    expect(report.conflicts.byField).toEqual({ ky: 1 });
  });
  it('conservation identity holds but flags NOT-ok due to the unexpected drop', () => {
    expect(report.conservation.expectedOut).toBe(5);
    expect(report.conservation.actualOut).toBe(5);
    expect(report.conservation.ok).toBe(false); // an unexpected entry blocks go
  });
});

describe('buildDriftReport — clean merge conserves (ok=true)', () => {
  it('a graduation-only scenario passes conservation', () => {
    const corpus = [
      rec({ id: 'blog-1-1', karaoke_numbers: { tj: null, ky: '600', joysound: null } }),
    ];
    const ky = [rec({ id: 'ky-600', karaoke_numbers: { tj: null, ky: '600', joysound: null } })];
    const out = [rec({ id: 'ky-600', karaoke_numbers: { tj: null, ky: '600', joysound: null } })];
    const report = buildDriftReport(corpus, ky, out, []);
    expect(report.unexpected.count).toBe(0);
    expect(report.graduated.count).toBe(1);
    expect(report.conservation.ok).toBe(true);
  });

  it('a KY input that vanishes without an absorber is unexpected', () => {
    const corpus = [rec({ id: 'tj-1', karaoke_numbers: { tj: '1', ky: null, joysound: null } })];
    const ky = [rec({ id: 'ky-900', karaoke_numbers: { tj: null, ky: '900', joysound: null } })];
    const out = [rec({ id: 'tj-1', karaoke_numbers: { tj: '1', ky: null, joysound: null } })]; // ky-900 gone, no absorber
    const report = buildDriftReport(corpus, ky, out, []);
    expect(report.unexpected.entries).toContainEqual({
      id: 'ky-900',
      reason: 'ky-input-disappeared-unabsorbed',
      ky: '900',
    });
    expect(report.conservation.ok).toBe(false);
  });
});

describe('runMergeDriver — real merger integration + determinism', () => {
  it('graduates a blog ky-claim into the live ky record and is byte-deterministic', async () => {
    const deps = await loadDist();
    const corpusRecords = [
      rec({ id: 'tj-1', karaoke_numbers: { tj: '1', ky: null, joysound: null } }),
      rec({
        id: 'blog-9-1',
        title_primary: '雪の華',
        artist_primary: '中島美嘉',
        title_ko: '눈의 꽃',
        karaoke_numbers: { tj: null, ky: '41637', joysound: null },
      }),
    ];
    const kyRecords = [
      rec({
        id: 'ky-41637',
        title_primary: '雪の華',
        artist_primary: '中島美嘉',
        source_url: 'https://kysing.kr/search/?category=1&keyword=41637',
        karaoke_numbers: { tj: null, ky: '41637', joysound: null },
      }),
    ];

    const a = runMergeDriver({ corpusRecords, kyRecords, ...deps });
    const b = runMergeDriver({ corpusRecords, kyRecords, ...deps });

    // blog-9-1 graduated into ky-41637; tj-1 kept.
    const ids = a.merged.map((r) => r.id).sort();
    expect(ids).toEqual(['ky-41637', 'tj-1']);
    expect(a.report.graduated.entries).toEqual([{ from: 'blog-9-1', to: 'ky-41637' }]);
    expect(a.report.conservation.ok).toBe(true);
    // Determinism: identical inputs → byte-identical merged corpus + report.
    expect(JSON.stringify(a.merged)).toBe(JSON.stringify(b.merged));
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });
});

describe('parseArgs', () => {
  it('parses the four required paths', () => {
    expect(parseArgs(['--corpus', 'c', '--ky', 'k', '--out', 'o', '--report', 'r'])).toEqual({
      corpus: 'c',
      ky: 'k',
      out: 'o',
      report: 'r',
      help: false,
    });
  });
  it('throws on unknown flags and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--corpus'])).toThrow(/requires a path/);
  });
});
