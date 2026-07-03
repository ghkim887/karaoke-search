// Tests for scripts/lib/agent-chunks.mjs — the transport-level chunk plumbing
// shared by the adjudicate + translate LLM-agent harnesses (chunking, per-chunk
// input files, reading agent-output chunk files, and the UTF-8-BOM review CSV).

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chunkRecords,
  listChunkFiles,
  parseFlag,
  readJsonChunks,
  writeChunkInputs,
  writeCsvWithBom,
} from './lib/agent-chunks.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-agent-chunks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('chunkRecords', () => {
  it('splits into consecutive chunks preserving order, last chunk smaller', () => {
    const recs = Array.from({ length: 7 }, (_, i) => i);
    expect(chunkRecords(recs, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
  });
  it('returns [] on empty input', () => {
    expect(chunkRecords([], 3)).toEqual([]);
  });
});

describe('writeChunkInputs', () => {
  it('writes one zero-padded file per chunk using the provided name builder', () => {
    writeChunkInputs(dir, [[{ a: 1 }], [{ b: 2 }]], (nn) => `chunk-${nn}-input.json`);
    expect(readdirSync(dir).sort()).toEqual(['chunk-00-input.json', 'chunk-01-input.json']);
    expect(JSON.parse(readFileSync(join(dir, 'chunk-01-input.json'), 'utf-8'))).toEqual([{ b: 2 }]);
  });

  it('creates the output directory first when ensureDir is set', () => {
    const nested = join(dir, 'a', 'b');
    writeChunkInputs(nested, [[{ a: 1 }]], (nn) => `c-${nn}.json`, { ensureDir: true });
    expect(existsSync(join(nested, 'c-00.json'))).toBe(true);
  });

  it('is byte-stable on identical input (idempotent atomic write)', () => {
    const chunks = [[{ a: 1, b: ['x'] }]];
    writeChunkInputs(dir, chunks, (nn) => `c-${nn}.json`);
    const first = readFileSync(join(dir, 'c-00.json'));
    writeChunkInputs(dir, chunks, (nn) => `c-${nn}.json`);
    expect(readFileSync(join(dir, 'c-00.json')).equals(first)).toBe(true);
  });
});

describe('listChunkFiles', () => {
  it('returns matching filenames sorted, excluding non-matches', () => {
    for (const f of ['b-01.json', 'a-00.json', 'skip.txt', 'other-00.json'])
      writeFileSync(join(dir, f), '[]');
    expect(listChunkFiles(dir, /^[ab]-\d+\.json$/)).toEqual(['a-00.json', 'b-01.json']);
  });
});

describe('readJsonChunks', () => {
  it('concatenates the arrays from every matching file in sorted order', () => {
    writeFileSync(join(dir, 'x-00.json'), JSON.stringify([1, 2]));
    writeFileSync(join(dir, 'x-01.json'), JSON.stringify([3]));
    writeFileSync(join(dir, 'ignore.json'), JSON.stringify([9]));
    expect(readJsonChunks(dir, /^x-\d+\.json$/)).toEqual([1, 2, 3]);
  });

  it('throws "<file>: expected JSON array" on a non-array file', () => {
    writeFileSync(join(dir, 'x-00.json'), JSON.stringify({ not: 'array' }));
    expect(() => readJsonChunks(dir, /^x-\d+\.json$/)).toThrow(/x-00\.json: expected JSON array/);
  });
});

describe('writeCsvWithBom', () => {
  it('prefixes a UTF-8 BOM and CSV-escapes every cell', () => {
    const p = join(dir, 'out.csv');
    writeCsvWithBom(p, [
      ['id', 'title'],
      ['1', 'a, b'],
      ['2', 'x "y"'],
    ]);
    const buf = readFileSync(p);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = buf.toString('utf-8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"a, b"');
    expect(csv).toContain('"x ""y"""');
    expect(csv.endsWith('\n')).toBe(true);
  });
});

describe('parseFlag', () => {
  it('returns the value following the flag, or undefined when absent', () => {
    expect(parseFlag(['node', 's', '--out', 'p.json'], '--out')).toBe('p.json');
    expect(parseFlag(['node', 's'], '--out')).toBeUndefined();
  });
});
