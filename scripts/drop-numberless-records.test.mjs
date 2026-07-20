import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  conservationHolds,
  droppedToJsonl,
  isNumberless,
  parseArgs,
  partitionByNumbers,
  runDropNumberless,
} from './drop-numberless-records.mjs';

const rec = (id, nums) => ({
  id,
  title_primary: id,
  artist_primary: 'A',
  karaoke_numbers: { tj: null, ky: null, joysound: null, ...nums },
});

describe('parseArgs', () => {
  it('parses the three required paths', () => {
    expect(parseArgs(['--in', 'a.json', '--out', 'b.json', '--dropped-out', 'd.jsonl'])).toEqual({
      in: 'a.json',
      out: 'b.json',
      droppedOut: 'd.jsonl',
      help: false,
    });
  });
  it('throws when a required flag is missing', () => {
    expect(() => parseArgs(['--in', 'a.json'])).toThrow(/missing required flag/);
  });
  it('throws on unknown flags', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

describe('isNumberless — EXACTLY tj/ky/joysound all null', () => {
  it('is true when all three are null', () => {
    expect(isNumberless(rec('blog-1', {}))).toBe(true);
  });
  it('is true when karaoke_numbers is absent', () => {
    expect(isNumberless({ id: 'blog-2' })).toBe(true);
  });
  it('is false when any single number is present', () => {
    expect(isNumberless(rec('tj-1', { tj: '100' }))).toBe(false);
    expect(isNumberless(rec('ky-1', { ky: '200' }))).toBe(false);
    expect(isNumberless(rec('joy-1', { joysound: '300' }))).toBe(false);
  });
});

describe('partitionByNumbers', () => {
  it('splits kept/dropped and preserves order', () => {
    const records = [
      rec('tj-1', { tj: '1' }),
      rec('blog-1', {}),
      rec('ky-1', { ky: '2' }),
      rec('blog-2', {}),
    ];
    const { kept, dropped } = partitionByNumbers(records);
    expect(kept.map((r) => r.id)).toEqual(['tj-1', 'ky-1']);
    expect(dropped.map((r) => r.id)).toEqual(['blog-1', 'blog-2']);
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

describe('droppedToJsonl', () => {
  it('is empty for zero drops', () => {
    expect(droppedToJsonl([])).toBe('');
  });
  it('is one line per row with a trailing newline', () => {
    const out = droppedToJsonl([{ id: 'a' }, { id: 'b' }]);
    expect(out).toBe('{"id":"a"}\n{"id":"b"}\n');
  });
});

describe('runDropNumberless (integration)', () => {
  let dir;
  const silent = { log: () => {}, error: () => {} };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drop-numberless-'));
  });

  it('drops numberless rows, preserves them to JSONL, and conserves count', () => {
    const inPath = join(dir, 'in.json');
    const outPath = join(dir, 'out.json');
    const droppedOut = join(dir, 'dropped.jsonl');
    const input = [rec('tj-1', { tj: '1' }), rec('blog-1', {}), rec('ky-1', { ky: '2' })];
    writeFileSync(inPath, JSON.stringify(input), 'utf-8');

    const code = runDropNumberless({ inPath, outPath, droppedOutPath: droppedOut, log: silent });

    expect(code).toBe(0);
    const kept = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(kept.map((r) => r.id)).toEqual(['tj-1', 'ky-1']);
    const droppedLines = readFileSync(droppedOut, 'utf-8').trimEnd().split('\n');
    expect(droppedLines).toHaveLength(1);
    expect(JSON.parse(droppedLines[0]).id).toBe('blog-1');
    // conservation: input === kept + dropped
    expect(kept.length + droppedLines.length).toBe(input.length);
    // atomic: canonical byte shape + no leftover .tmp
    expect(readFileSync(outPath, 'utf-8')).toBe(`${JSON.stringify(kept, null, 2)}\n`);
    expect(existsSync(`${outPath}.tmp`)).toBe(false);
    expect(existsSync(`${droppedOut}.tmp`)).toBe(false);
  });

  it('with zero drops still writes the full corpus and an empty JSONL', () => {
    const inPath = join(dir, 'in.json');
    const outPath = join(dir, 'out.json');
    const droppedOut = join(dir, 'dropped.jsonl');
    const input = [rec('tj-1', { tj: '1' }), rec('ky-1', { ky: '2' })];
    writeFileSync(inPath, JSON.stringify(input), 'utf-8');

    const code = runDropNumberless({ inPath, outPath, droppedOutPath: droppedOut, log: silent });

    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, 'utf-8'))).toHaveLength(2);
    expect(readFileSync(droppedOut, 'utf-8')).toBe('');
  });

  it('returns exit 2 when the input corpus is missing', () => {
    const code = runDropNumberless({
      inPath: join(dir, 'nope.json'),
      outPath: join(dir, 'out.json'),
      droppedOutPath: join(dir, 'd.jsonl'),
      log: silent,
    });
    expect(code).toBe(2);
  });
});
