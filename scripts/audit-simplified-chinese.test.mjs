// Tests for scripts/audit-simplified-chinese.mjs — the report-only
// simplified-Chinese-leak audit. The predicate's own correctness (the curated
// set, the shinjitai trap) is tested in packages/search; here we test the
// audit's orchestration: field selection, matched-char union, JSONL shape, the
// histogram, and that it NEVER gates on findings. A tiny fake matcher keeps
// these hermetic (no built search dist needed).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildJsonl,
  parseArgs,
  runAudit,
  scanCorpus,
  scanRecord,
} from './audit-simplified-chinese.mjs';

// Fake matcher over a 3-char set — mirrors the real matcher's shape (`test`
// boolean + `chars` distinct-in-order) without importing the search dist.
const FAKE_SET = new Set(['爱', '们', '张']);
const fakeMatcher = {
  test: (text) => [...String(text ?? '')].some((c) => FAKE_SET.has(c)),
  chars: (text) => {
    const out = [];
    const seen = new Set();
    for (const c of String(text ?? '')) {
      if (FAKE_SET.has(c) && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out;
  },
};

const FIXTURE = [
  { id: 'tj-1', title_primary: '爱', artist_primary: 'X' },
  { id: 'tj-2', title_primary: '夜に駆ける', artist_primary: 'YOASOBI' },
  { id: 'tj-3', title_primary: 'Song', artist_primary: '张三', artist_aliases: ['Zhang San'] },
  { id: 'tj-4', title_primary: '我们', artist_primary: 'A', artist_aliases: ['爱好者'] },
];

describe('parseArgs', () => {
  it('defaults to no corpus / no out dir', () => {
    expect(parseArgs([])).toEqual({ corpusPath: null, outDir: null, help: false });
  });

  it('reads a positional corpus path and --out', () => {
    const parsed = parseArgs(['full.json', '--out', 'dir']);
    expect(parsed.corpusPath).toBe('full.json');
    expect(parsed.outDir).toBe('dir');
  });

  it('throws on an unknown flag, a missing --out value, and an extra positional', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--out'])).toThrow(/--out requires/);
    expect(() => parseArgs(['a.json', 'b.json'])).toThrow(/unexpected extra/);
  });
});

describe('scanRecord', () => {
  it('flags a title-only match', () => {
    expect(scanRecord(FIXTURE[0], fakeMatcher)).toEqual({
      id: 'tj-1',
      title_primary: '爱',
      artist_primary: 'X',
      matched_chars: ['爱'],
      matched_fields: ['title_primary'],
    });
  });

  it('returns null for a clean Japanese row', () => {
    expect(scanRecord(FIXTURE[1], fakeMatcher)).toBeNull();
  });

  it('flags an artist_primary match but not a clean alias', () => {
    const suspect = scanRecord(FIXTURE[2], fakeMatcher);
    expect(suspect.matched_fields).toEqual(['artist_primary']);
    expect(suspect.matched_chars).toEqual(['张']);
  });

  it('unions matches across title and an alias (distinct, first-appearance order)', () => {
    const suspect = scanRecord(FIXTURE[3], fakeMatcher);
    expect(suspect.matched_fields).toEqual(['title_primary', 'artist_aliases[0]']);
    expect(suspect.matched_chars).toEqual(['们', '爱']);
  });
});

describe('scanCorpus', () => {
  it('reports scanned/suspect counts and a descending-count histogram', () => {
    const { suspects, summary } = scanCorpus(FIXTURE, fakeMatcher);
    expect(summary.scanned).toBe(4);
    expect(summary.suspectCount).toBe(3);
    expect(suspects.map((s) => s.id)).toEqual(['tj-1', 'tj-3', 'tj-4']);
    // 爱 fires on tj-1 and tj-4 (2 rows); 们 and 张 on one each. 爱 ranks first.
    expect(summary.charHistogram[0]).toEqual(['爱', 2]);
    expect(new Map(summary.charHistogram).get('们')).toBe(1);
    expect(new Map(summary.charHistogram).get('张')).toBe(1);
  });
});

describe('buildJsonl', () => {
  it('emits one parseable JSON object per suspect, no trailing newline', () => {
    const { suspects } = scanCorpus(FIXTURE, fakeMatcher);
    const jsonl = buildJsonl(suspects);
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(['tj-1', 'tj-3', 'tj-4']);
  });

  it('returns an empty string for zero suspects', () => {
    expect(buildJsonl([])).toBe('');
  });
});

describe('runAudit', () => {
  let dir;
  const silent = { log: () => {}, error: () => {} };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-simpl-cn-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSONL and returns 0 even WITH suspects (report-only, never gated)', () => {
    const corpusPath = join(dir, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify(FIXTURE), 'utf-8');
    const code = runAudit({ corpusPath, outDir: dir, matcher: fakeMatcher, log: silent });
    expect(code).toBe(0);
    const written = readFileSync(join(dir, 'suspects.jsonl'), 'utf-8').trim().split('\n');
    expect(written.map((l) => JSON.parse(l).id)).toEqual(['tj-1', 'tj-3', 'tj-4']);
  });

  it('writes an empty file for an all-clean corpus and still returns 0', () => {
    const corpusPath = join(dir, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify([FIXTURE[1]]), 'utf-8');
    const code = runAudit({ corpusPath, outDir: dir, matcher: fakeMatcher, log: silent });
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'suspects.jsonl'), 'utf-8')).toBe('');
  });

  it('returns 2 for a missing corpus', () => {
    const code = runAudit({
      corpusPath: join(dir, 'nope.json'),
      outDir: dir,
      matcher: fakeMatcher,
      log: silent,
    });
    expect(code).toBe(2);
  });
});
