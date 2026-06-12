import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildOverrideArrays,
  chunkRecords,
  dedupeQueueRecords,
  normalizeSelSongNo,
  parseQueueTsv,
  runMerge,
  runPrep,
  validateChunkOutputs,
  writeChunkInputs,
  writeReviewCsv,
} from './adjudicate_joysound_via_agents.mjs';

const QUEUE_HEADER = [
  'bucket',
  'priority',
  'selSongNo',
  'title',
  'artist',
  'decision',
  'reason',
  'script_signal',
  'why_flagged',
  'suggested_verdict',
  'reviewer_verdict',
  'reviewer_note',
].join('\t');

/** Build a TSV string from row objects using the canonical column order. */
function tsv(rows) {
  const cols = QUEUE_HEADER.split('\t');
  const lines = [QUEUE_HEADER, ...rows.map((r) => cols.map((c) => String(r[c] ?? '')).join('\t'))];
  return `${lines.join('\n')}\n`;
}

function fpRow(overrides = {}) {
  return {
    bucket: 'existingNumberConflict',
    priority: 'P0',
    selSongNo: '640256',
    title: 'IRIS OUT',
    artist: '米津玄師',
    decision: 'admit',
    reason: 'admit-jp-artist',
    script_signal: 'han',
    why_flagged: 'admitted JOYSOUND number already in corpus but maps to a different title/artist',
    suggested_verdict: 'DROP_FALSE_POSITIVE',
    reviewer_verdict: '',
    reviewer_note: '',
    ...overrides,
  };
}

function fnRow(overrides = {}) {
  return {
    bucket: 'droppedHasKana',
    priority: 'P0',
    selSongNo: '613117',
    title: 'ありがとう',
    artist: 'TREASURE',
    decision: 'drop',
    reason: 'foreign-korean',
    script_signal: 'kana',
    why_flagged: 'dropped though title/artist has kana',
    suggested_verdict: 'ADD_FALSE_NEGATIVE',
    reviewer_verdict: '',
    reviewer_note: '',
    ...overrides,
  };
}

describe('normalizeSelSongNo', () => {
  it('strips hyphens and trims whitespace', () => {
    expect(normalizeSelSongNo('190-001')).toBe('190001');
    expect(normalizeSelSongNo('  640256 ')).toBe('640256');
    expect(normalizeSelSongNo('1-2-3')).toBe('123');
  });

  it('treats hyphenated and dashless forms as the same key', () => {
    expect(normalizeSelSongNo('190-001')).toBe(normalizeSelSongNo('190001'));
  });
});

describe('parseQueueTsv', () => {
  it('parses header + rows into objects keyed by column', () => {
    const rows = parseQueueTsv(tsv([fpRow()]));
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket).toBe('existingNumberConflict');
    expect(rows[0].selSongNo).toBe('640256');
    expect(rows[0].artist).toBe('米津玄師');
  });

  it('handles trailing newline and ignores blank trailing lines', () => {
    const rows = parseQueueTsv(`${tsv([fpRow(), fnRow()])}\n`);
    expect(rows).toHaveLength(2);
  });

  it('throws when the header does not match the queue contract', () => {
    expect(() => parseQueueTsv('a\tb\tc\n1\t2\t3\n')).toThrow(/header/i);
  });
});

describe('dedupeQueueRecords', () => {
  it('collapses a selSongNo that appears in two FN buckets into one record with union buckets', () => {
    const fnRows = [
      fnRow({ bucket: 'droppedHasKana', selSongNo: '613117', reason: 'foreign-korean' }),
      fnRow({
        bucket: 'droppedForeignButJpRelease',
        selSongNo: '613117',
        reason: 'foreign-jp-release',
      }),
    ];
    const { fn } = dedupeQueueRecords([], fnRows);
    expect(fn).toHaveLength(1);
    expect(fn[0].selSongNo).toBe('613117');
    expect(fn[0].buckets.sort()).toEqual(['droppedForeignButJpRelease', 'droppedHasKana']);
    expect(fn[0].reasons.sort()).toEqual(['foreign-jp-release', 'foreign-korean']);
  });

  it('normalizes selSongNo so 190-001 and 190001 collapse to one record', () => {
    const fnRows = [
      fnRow({ bucket: 'droppedHasKana', selSongNo: '190-001' }),
      fnRow({ bucket: 'droppedKnownJpArtist', selSongNo: '190001' }),
    ];
    const { fn } = dedupeQueueRecords([], fnRows);
    expect(fn).toHaveLength(1);
    expect(fn[0].selSongNo).toBe('190001');
    expect(fn[0].buckets.sort()).toEqual(['droppedHasKana', 'droppedKnownJpArtist']);
  });

  it('routes a song appearing in BOTH FP and FN to the FP stream only (FP wins)', () => {
    const fpRows = [fpRow({ selSongNo: '111' })];
    const fnRows = [fnRow({ selSongNo: '111' })];
    const { fp, fn, collapsed } = dedupeQueueRecords(fpRows, fnRows);
    expect(fp.map((r) => r.selSongNo)).toEqual(['111']);
    expect(fn).toHaveLength(0);
    // FP carries the union of buckets across both streams.
    expect(fp[0].buckets).toContain('existingNumberConflict');
    expect(fp[0].buckets).toContain('droppedHasKana');
    expect(collapsed.crossStream).toBe(1);
  });

  it('sorts each stream deterministically by normalized selSongNo', () => {
    const fnRows = [
      fnRow({ selSongNo: '900' }),
      fnRow({ selSongNo: '100' }),
      fnRow({ selSongNo: '500' }),
    ];
    const { fn } = dedupeQueueRecords([], fnRows);
    expect(fn.map((r) => r.selSongNo)).toEqual(['100', '500', '900']);
  });

  it('reports the dedup collapse count (rows in minus distinct out)', () => {
    const fnRows = [
      fnRow({ bucket: 'droppedHasKana', selSongNo: '1' }),
      fnRow({ bucket: 'droppedForeignButJpRelease', selSongNo: '1' }),
      fnRow({ bucket: 'droppedKnownJpArtist', selSongNo: '2' }),
    ];
    const { fn, collapsed } = dedupeQueueRecords([], fnRows);
    expect(fn).toHaveLength(2);
    expect(collapsed.fnRowsIn).toBe(3);
    expect(collapsed.fnDistinct).toBe(2);
  });
});

describe('chunkRecords', () => {
  it('splits into chunks of the requested size, last chunk smaller', () => {
    const records = Array.from({ length: 525 }, (_, i) => ({ selSongNo: String(i) }));
    const chunks = chunkRecords(records, 250);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(250);
    expect(chunks[2]).toHaveLength(25);
  });

  it('returns an empty array on empty input', () => {
    expect(chunkRecords([], 250)).toEqual([]);
  });
});

describe('writeChunkInputs', () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'joy-adj-chunk-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes one zero-padded file per chunk under the given stream prefix', () => {
    writeChunkInputs(workdir, 'fp', [[{ selSongNo: '1' }], [{ selSongNo: '2' }]]);
    const files = readdirSync(workdir).sort();
    expect(files).toEqual([
      'adjudicate-fp-chunk-00-input.json',
      'adjudicate-fp-chunk-01-input.json',
    ]);
  });

  it('is byte-stable on identical input (idempotent)', () => {
    const chunks = [[{ selSongNo: '1', buckets: ['a'] }]];
    writeChunkInputs(workdir, 'fn', chunks);
    const first = readFileSync(join(workdir, 'adjudicate-fn-chunk-00-input.json'));
    writeChunkInputs(workdir, 'fn', chunks);
    const second = readFileSync(join(workdir, 'adjudicate-fn-chunk-00-input.json'));
    expect(first.equals(second)).toBe(true);
  });
});

describe('runPrep — integration', () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'joy-adj-prep-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('dedups across buckets/streams, chunks both streams, writes a manifest', () => {
    const fpPath = join(workdir, 'fp.tsv');
    const fnPath = join(workdir, 'fn.tsv');
    const outDir = join(workdir, 'out');
    writeFileSync(fpPath, tsv([fpRow({ selSongNo: '640256' }), fpRow({ selSongNo: '430643' })]));
    writeFileSync(
      fnPath,
      tsv([
        // Same selSongNo in two FN buckets -> collapses to one FN record.
        fnRow({ bucket: 'droppedHasKana', selSongNo: '613117' }),
        fnRow({ bucket: 'droppedForeignButJpRelease', selSongNo: '613117' }),
        fnRow({ bucket: 'droppedKnownJpArtist', selSongNo: '999' }),
      ]),
    );

    const manifest = runPrep({ fpPath, fnPath, outDir, chunkSize: 250 });
    expect(manifest.fp.distinct).toBe(2);
    expect(manifest.fn.distinct).toBe(2);
    expect(manifest.distinctTotal).toBe(4);
    expect(manifest.fn.rowsIn).toBe(3);

    const files = readdirSync(outDir).sort();
    expect(files).toContain('adjudicate-fp-chunk-00-input.json');
    expect(files).toContain('adjudicate-fn-chunk-00-input.json');
    expect(files).toContain('prep-manifest.json');

    const fpChunk = JSON.parse(
      readFileSync(join(outDir, 'adjudicate-fp-chunk-00-input.json'), 'utf-8'),
    );
    // Sorted by normalized selSongNo: 430643 before 640256.
    expect(fpChunk.map((r) => r.selSongNo)).toEqual(['430643', '640256']);
    expect(fpChunk[0]).toMatchObject({
      selSongNo: '430643',
      title: expect.any(String),
      artist: expect.any(String),
      buckets: ['existingNumberConflict'],
      suggested_verdict: 'DROP_FALSE_POSITIVE',
    });
  });

  it('produces byte-identical chunk files across two prep runs (determinism)', () => {
    const fpPath = join(workdir, 'fp.tsv');
    const fnPath = join(workdir, 'fn.tsv');
    writeFileSync(fpPath, tsv([fpRow({ selSongNo: '5' }), fpRow({ selSongNo: '3' })]));
    writeFileSync(fnPath, tsv([fnRow({ selSongNo: '9' })]));

    const outA = join(workdir, 'a');
    const outB = join(workdir, 'b');
    runPrep({ fpPath, fnPath, outDir: outA, chunkSize: 250 });
    runPrep({ fpPath, fnPath, outDir: outB, chunkSize: 250 });
    const a = readFileSync(join(outA, 'adjudicate-fp-chunk-00-input.json'));
    const b = readFileSync(join(outB, 'adjudicate-fp-chunk-00-input.json'));
    expect(a.equals(b)).toBe(true);
  });
});

describe('validateChunkOutputs', () => {
  function inputRecord(selSongNo, buckets = ['existingNumberConflict']) {
    return { selSongNo, title: 'T', artist: 'A', buckets, reason: 'r' };
  }

  it('passes when every input has exactly one valid verdict', () => {
    const inputs = [inputRecord('1'), inputRecord('2')];
    const outputs = [
      { selSongNo: '1', verdict: 'DROP', reason: 'foreign act' },
      { selSongNo: '2', verdict: 'LEAVE_ADMITTED', reason: 'genuine jp' },
    ];
    const verdicts = validateChunkOutputs(inputs, outputs);
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toMatchObject({ selSongNo: '1', verdict: 'DROP' });
  });

  it('normalizes output selSongNo keys before matching', () => {
    const inputs = [inputRecord('190001')];
    const outputs = [{ selSongNo: '190-001', verdict: 'ALLOW', reason: 'ok' }];
    expect(() => validateChunkOutputs(inputs, outputs)).not.toThrow();
  });

  it('throws listing missing selSongNo when an input has no verdict', () => {
    const inputs = [inputRecord('1'), inputRecord('2')];
    const outputs = [{ selSongNo: '1', verdict: 'DROP', reason: 'r' }];
    expect(() => validateChunkOutputs(inputs, outputs)).toThrow(/missing.*\b2\b/i);
  });

  it('throws on an unknown selSongNo not present in the prep inputs', () => {
    const inputs = [inputRecord('1')];
    const outputs = [
      { selSongNo: '1', verdict: 'DROP', reason: 'r' },
      { selSongNo: '999', verdict: 'ALLOW', reason: 'r' },
    ];
    expect(() => validateChunkOutputs(inputs, outputs)).toThrow(/unknown.*999/i);
  });

  it('throws on a bad verdict enum value', () => {
    const inputs = [inputRecord('1')];
    const outputs = [{ selSongNo: '1', verdict: 'MAYBE', reason: 'r' }];
    expect(() => validateChunkOutputs(inputs, outputs)).toThrow(/verdict/i);
  });

  it('throws on a duplicate selSongNo in the outputs', () => {
    const inputs = [inputRecord('1')];
    const outputs = [
      { selSongNo: '1', verdict: 'DROP', reason: 'r' },
      { selSongNo: '1', verdict: 'ALLOW', reason: 'r' },
    ];
    expect(() => validateChunkOutputs(inputs, outputs)).toThrow(/duplicate/i);
  });
});

describe('buildOverrideArrays', () => {
  it('emits only ALLOW/DROP verdicts, hyphen-stripped + sorted + deduped', () => {
    const verdicts = [
      { selSongNo: '640256', verdict: 'ALLOW' },
      { selSongNo: '430643', verdict: 'DROP' },
      { selSongNo: '999', verdict: 'LEAVE_ADMITTED' },
      { selSongNo: '888', verdict: 'LEAVE_DROPPED' },
      { selSongNo: '100200', verdict: 'ALLOW' },
    ];
    const { allow, drop } = buildOverrideArrays(verdicts);
    expect(allow).toEqual(['100200', '640256']);
    expect(drop).toEqual(['430643']);
  });

  it('dedups and normalizes hyphenated keys', () => {
    const verdicts = [
      { selSongNo: '190-001', verdict: 'ALLOW' },
      { selSongNo: '190001', verdict: 'ALLOW' },
    ];
    const { allow } = buildOverrideArrays(verdicts);
    expect(allow).toEqual(['190001']);
  });
});

describe('writeReviewCsv', () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'joy-adj-csv-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('writes a UTF-8 BOM as the first bytes and the canonical header', () => {
    const path = join(workdir, 'review.csv');
    writeReviewCsv(path, [
      {
        selSongNo: '1',
        title: '愛',
        artist: 'A',
        buckets: ['existingNumberConflict'],
        verdict: 'DROP',
        reason: 'foreign',
        web_sources: [],
      },
    ]);
    const buf = readFileSync(path);
    // UTF-8 BOM = EF BB BF.
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    const csv = buf.toString('utf-8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\n')[0]).toBe('﻿selSongNo,title,artist,buckets,verdict,reason,web_sources');
  });

  it('escapes fields with commas, quotes, and newlines', () => {
    const path = join(workdir, 'review.csv');
    writeReviewCsv(path, [
      {
        selSongNo: '1',
        title: 'a, b',
        artist: 'x "y"',
        buckets: ['droppedHasKana', 'droppedKnownJpArtist'],
        verdict: 'ALLOW',
        reason: 'line1\nline2',
        web_sources: ['https://a.test', 'https://b.test'],
      },
    ]);
    const csv = readFileSync(path, 'utf-8');
    expect(csv).toContain('"a, b"');
    expect(csv).toContain('"x ""y"""');
    expect(csv).toContain('"line1\nline2"');
    // buckets + web_sources joined and the joined string CSV-escaped if needed.
    expect(csv).toContain('droppedHasKana; droppedKnownJpArtist');
    expect(csv).toContain('https://a.test; https://b.test');
  });
});

describe('runMerge — integration', () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'joy-adj-merge-'));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function setupPrep(outDir) {
    const fpPath = join(workdir, 'fp.tsv');
    const fnPath = join(workdir, 'fn.tsv');
    writeFileSync(fpPath, tsv([fpRow({ selSongNo: '640256' })]));
    writeFileSync(
      fnPath,
      tsv([
        fnRow({ bucket: 'droppedHasKana', selSongNo: '613117' }),
        fnRow({ bucket: 'droppedForeignButJpRelease', selSongNo: '613117' }),
      ]),
    );
    runPrep({ fpPath, fnPath, outDir, chunkSize: 250 });
  }

  it('end-to-end: prep inputs + agent outputs -> verdicts.json, override-arrays.txt, review CSV', () => {
    const outDir = join(workdir, 'out');
    setupPrep(outDir);

    writeFileSync(
      join(outDir, 'adjudicate-fp-chunk-00.json'),
      JSON.stringify([{ selSongNo: '640256', verdict: 'LEAVE_ADMITTED', reason: 'genuine米津' }]),
    );
    writeFileSync(
      join(outDir, 'adjudicate-fn-chunk-00.json'),
      JSON.stringify([
        {
          selSongNo: '613117',
          verdict: 'DROP',
          reason: 'korean act',
          web_sources: ['https://x.test'],
        },
      ]),
    );

    const reviewCsvPath = join(outDir, 'review.csv');
    const stats = runMerge({ outDir, reviewCsvPath });
    expect(stats.verdictCount).toBe(2);

    const verdicts = JSON.parse(readFileSync(join(outDir, 'verdicts.json'), 'utf-8'));
    expect(verdicts).toHaveLength(2);
    const byNo = new Map(verdicts.map((v) => [v.selSongNo, v]));
    expect(byNo.get('640256')).toMatchObject({
      selSongNo: '640256',
      verdict: 'LEAVE_ADMITTED',
      buckets: ['existingNumberConflict'],
    });
    expect(byNo.get('613117').buckets.sort()).toEqual([
      'droppedForeignButJpRelease',
      'droppedHasKana',
    ]);

    const arraysTxt = readFileSync(join(outDir, 'override-arrays.txt'), 'utf-8');
    // Only the DROP (613117) lands in the DROP array; the LEAVE_ADMITTED does not.
    expect(arraysTxt).toContain("'613117'");
    expect(arraysTxt).not.toContain("'640256'");
    expect(existsSync(reviewCsvPath)).toBe(true);
  });

  it('errors when an input selSongNo is missing a verdict in the outputs', () => {
    const outDir = join(workdir, 'out');
    setupPrep(outDir);
    // FP output present, FN output missing 613117.
    writeFileSync(
      join(outDir, 'adjudicate-fp-chunk-00.json'),
      JSON.stringify([{ selSongNo: '640256', verdict: 'DROP', reason: 'r' }]),
    );
    writeFileSync(join(outDir, 'adjudicate-fn-chunk-00.json'), JSON.stringify([]));
    expect(() => runMerge({ outDir })).toThrow(/missing.*613117/i);
  });
});
