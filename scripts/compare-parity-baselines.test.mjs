// Tests for scripts/compare-parity-baselines.mjs — the weekly-crawl helper that
// renders the drift between the committed search-parity baseline and the one
// regenerated from the freshly crawled corpus into a PR-body markdown section.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REGRESSION_TAG,
  assertBaselineShape,
  compareBaselines,
  loadBaseline,
  parseArgs,
  runCli,
} from './compare-parity-baselines.mjs';

function query(text, jaccard, top1Match) {
  return { query: text, vendors: [], jaccard, top1Match, web: [], worker: [] };
}

function makeBaseline(overrides = {}) {
  const {
    meanJaccard = 0.6,
    top1MatchRate = 0.78,
    records = 26133,
    sha256 = 'a'.repeat(64),
    queries = {},
  } = overrides;
  return {
    _readme: 'AUTO-GENERATED baseline (test fixture).',
    corpus: { path: 'apps/web/public/data/songs.json', sha256, records },
    aggregate: { queryCount: Object.keys(queries).length, meanJaccard, top1MatchRate },
    queries,
  };
}

function makeWriter() {
  const chunks = [];
  return { chunks, write: (s) => chunks.push(String(s)), text: () => chunks.join('') };
}

describe('compareBaselines: zero drift', () => {
  it('emits the no-drift line and no table when nothing changed', () => {
    const base = makeBaseline({
      queries: { a: query('夜に駆ける', 0.5, true), b: query('紅蓮華', 0.75, false) },
    });
    const result = compareBaselines(base, structuredClone(base));
    expect(result.hasRegression).toBe(false);
    expect(result.changedCount).toBe(0);
    expect(result.querySetChanged).toBe(false);
    expect(result.markdown).toContain('No per-query drift');
    expect(result.markdown).not.toContain('| Query id |');
    expect(result.markdown).not.toContain('[!WARNING]');
    // Aggregate lines are always present, even at zero drift.
    expect(result.markdown).toContain('- Mean Jaccard: 0.600000 -> 0.600000 (+0.000000)');
    expect(result.markdown).toContain('- Corpus records: 26133 -> 26133 (+0)');
  });
});

describe('compareBaselines: improvement', () => {
  it('renders a row marked "improved" with no regression flag when Jaccard rises', () => {
    const oldB = makeBaseline({ queries: { a: query('夜に駆ける', 0.5, true) } });
    const newB = makeBaseline({ queries: { a: query('夜に駆ける', 0.75, true) } });
    const result = compareBaselines(oldB, newB);
    expect(result.hasRegression).toBe(false);
    expect(result.changedCount).toBe(1);
    expect(result.markdown).toContain('| Query id |');
    expect(result.markdown).toContain('0.500000 -> 0.750000 (+0.250000)');
    expect(result.markdown).toContain('| improved |');
    expect(result.markdown).not.toContain(REGRESSION_TAG);
    expect(result.markdown).not.toContain('[!WARNING]');
  });

  it('treats a gained top-1 agreement (no -> yes) as an improvement, not a regression', () => {
    const oldB = makeBaseline({ queries: { a: query('曲', 0.5, false) } });
    const newB = makeBaseline({ queries: { a: query('曲', 0.5, true) } });
    const result = compareBaselines(oldB, newB);
    expect(result.hasRegression).toBe(false);
    expect(result.markdown).toContain('no -> yes');
    expect(result.markdown).toContain('| improved |');
  });
});

describe('compareBaselines: regression', () => {
  it('flags a dropped Jaccard loudly and emits the WARNING banner', () => {
    const oldB = makeBaseline({ queries: { a: query('夜に駆ける', 0.5, true) } });
    const newB = makeBaseline({ queries: { a: query('夜に駆ける', 0.3, true) } });
    const result = compareBaselines(oldB, newB);
    expect(result.hasRegression).toBe(true);
    expect(result.regressionCount).toBe(1);
    expect(result.markdown).toContain(REGRESSION_TAG);
    expect(result.markdown).toContain('0.500000 -> 0.300000 (-0.200000)');
    expect(result.markdown).toContain('> [!WARNING]');
    expect(result.markdown).toContain('1 query regressed');
  });

  it('flags a lost top-1 agreement (yes -> no) as a regression even when Jaccard holds', () => {
    const oldB = makeBaseline({ queries: { a: query('曲', 0.6, true) } });
    const newB = makeBaseline({ queries: { a: query('曲', 0.6, false) } });
    const result = compareBaselines(oldB, newB);
    expect(result.hasRegression).toBe(true);
    expect(result.regressionCount).toBe(1);
    expect(result.markdown).toContain('yes -> no');
    expect(result.markdown).toContain(REGRESSION_TAG);
  });

  it('pluralizes and counts multiple regressions', () => {
    const oldB = makeBaseline({
      queries: { a: query('x', 0.5, true), b: query('y', 0.4, true), c: query('z', 0.9, true) },
    });
    const newB = makeBaseline({
      queries: { a: query('x', 0.3, true), b: query('y', 0.4, false), c: query('z', 0.9, true) },
    });
    const result = compareBaselines(oldB, newB);
    expect(result.regressionCount).toBe(2);
    expect(result.changedCount).toBe(2); // c unchanged, omitted
    expect(result.markdown).toContain('2 queries regressed');
  });
});

describe('compareBaselines: corpus-count change', () => {
  it('renders a signed record-count delta on the aggregate line', () => {
    const oldB = makeBaseline({ records: 26133, queries: { a: query('x', 0.5, true) } });
    const newB = makeBaseline({ records: 26140, queries: { a: query('x', 0.5, true) } });
    const result = compareBaselines(oldB, newB);
    expect(result.changedCount).toBe(0); // corpus grew but this query held
    expect(result.markdown).toContain('- Corpus records: 26133 -> 26140 (+7)');
    expect(result.markdown).toContain('No per-query drift');
  });

  it('renders a negative record-count delta', () => {
    const oldB = makeBaseline({ records: 26140, queries: {} });
    const newB = makeBaseline({ records: 26100, queries: {} });
    expect(compareBaselines(oldB, newB).markdown).toContain(
      '- Corpus records: 26140 -> 26100 (-40)',
    );
  });
});

describe('compareBaselines: query-set change', () => {
  it('surfaces added and removed queries separately from Jaccard regressions', () => {
    const oldB = makeBaseline({
      queries: { a: query('x', 0.5, true), gone: query('g', 0.9, true) },
    });
    const newB = makeBaseline({
      queries: { a: query('x', 0.5, true), fresh: query('f', 0.4, false) },
    });
    const result = compareBaselines(oldB, newB);
    expect(result.added).toEqual(['fresh']);
    expect(result.removed).toEqual(['gone']);
    expect(result.querySetChanged).toBe(true);
    expect(result.hasRegression).toBe(false); // add/remove is not a Jaccard regression
    expect(result.markdown).toContain('query set changed (added)');
    expect(result.markdown).toContain('query set changed (removed)');
    expect(result.markdown).toContain('Query set changed (added: fresh; removed: gone)');
  });
});

describe('compareBaselines: markdown cell safety', () => {
  it('escapes a pipe in the query text so it cannot break the table', () => {
    const oldB = makeBaseline({ queries: { a: query('a|b', 0.5, true) } });
    const newB = makeBaseline({ queries: { a: query('a|b', 0.3, true) } });
    expect(compareBaselines(oldB, newB).markdown).toContain('| a\\|b |');
  });
});

describe('parseArgs', () => {
  it('parses two positional baseline paths', () => {
    expect(parseArgs(['old.json', 'new.json'])).toEqual({
      oldPath: 'old.json',
      newPath: 'new.json',
      help: false,
    });
  });

  it('parses --help / -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });

  it('throws on the wrong number of positionals', () => {
    expect(() => parseArgs(['only-one.json'])).toThrow(/expected exactly 2 positional arguments/);
    expect(() => parseArgs(['a', 'b', 'c'])).toThrow(/got 3/);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--nope', 'a', 'b'])).toThrow(/unknown argument: --nope/);
  });
});

describe('assertBaselineShape', () => {
  it('accepts a well-formed baseline', () => {
    const base = makeBaseline({ queries: { a: query('x', 0.5, true) } });
    expect(assertBaselineShape(base, 'label')).toBe(base);
  });

  it('throws (naming the label) on a missing queries object', () => {
    const bad = makeBaseline();
    bad.queries = undefined;
    expect(() => assertBaselineShape(bad, 'old baseline')).toThrow(
      /old baseline: missing "queries"/,
    );
  });

  it('throws on a non-numeric jaccard', () => {
    const bad = makeBaseline({ queries: { a: { query: 'x', jaccard: '0.5', top1Match: true } } });
    expect(() => assertBaselineShape(bad, 'L')).toThrow(/queries.a.jaccard is not a number/);
  });

  it('throws on a non-boolean top1Match', () => {
    const bad = makeBaseline({ queries: { a: { query: 'x', jaccard: 0.5, top1Match: 1 } } });
    expect(() => assertBaselineShape(bad, 'L')).toThrow(/queries.a.top1Match is not a boolean/);
  });

  it('throws on a non-integer record count', () => {
    const bad = makeBaseline();
    bad.corpus.records = 1.5;
    expect(() => assertBaselineShape(bad, 'L')).toThrow(/corpus.records is not an integer/);
  });
});

describe('loadBaseline + runCli (fs round-trip)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compare-parity-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeBaseline(name, baseline) {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    return path;
  }

  it('loadBaseline reads and validates a file', () => {
    const path = writeBaseline('b.json', makeBaseline({ queries: { a: query('x', 0.5, true) } }));
    expect(loadBaseline(path).corpus.records).toBe(26133);
  });

  it('loadBaseline throws a labelled error on invalid JSON', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not json', 'utf8');
    expect(() => loadBaseline(path, 'new baseline')).toThrow(/new baseline: invalid JSON/);
  });

  it('loadBaseline throws a labelled error when the file is missing', () => {
    expect(() => loadBaseline(join(dir, 'nope.json'), 'old baseline')).toThrow(
      /old baseline: cannot read baseline file/,
    );
  });

  it('runCli writes the markdown to stdout and returns 0 on success', () => {
    const oldPath = writeBaseline(
      'old.json',
      makeBaseline({ queries: { a: query('x', 0.5, true) } }),
    );
    const newPath = writeBaseline(
      'new.json',
      makeBaseline({ queries: { a: query('x', 0.3, true) } }),
    );
    const out = makeWriter();
    const err = makeWriter();
    const code = runCli([oldPath, newPath], out, err);
    expect(code).toBe(0);
    expect(err.text()).toBe('');
    expect(out.text()).toContain(REGRESSION_TAG);
    expect(out.text().endsWith('\n')).toBe(true);
  });

  it('runCli returns 1 and writes usage to stderr on bad args', () => {
    const out = makeWriter();
    const err = makeWriter();
    expect(runCli(['only-one'], out, err)).toBe(1);
    expect(err.text()).toContain('expected exactly 2 positional arguments');
    expect(err.text()).toContain('Usage:');
    expect(out.text()).toBe('');
  });

  it('runCli returns 1 when a baseline file is malformed', () => {
    const good = writeBaseline('good.json', makeBaseline({ queries: {} }));
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{}', 'utf8');
    const err = makeWriter();
    expect(runCli([good, badPath], makeWriter(), err)).toBe(1);
    expect(err.text()).toContain('missing "aggregate"');
  });

  it('runCli prints usage and returns 0 for --help', () => {
    const out = makeWriter();
    expect(runCli(['--help'], out, makeWriter())).toBe(0);
    expect(out.text()).toContain('Usage:');
  });
});
