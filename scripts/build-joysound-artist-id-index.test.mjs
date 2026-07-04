// Tests for scripts/build-joysound-artist-id-index.mjs — the R4-4 extractor
// that distils JOYSOUND artistId out of the retained detail-sweep logs. Covers
// the pure folding/serialisation logic and one streamed end-to-end build over a
// temp JSONL, with the clustering primitives stubbed so the test stays hermetic
// (no crawler-dist dependency).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIndex,
  createAccumulator,
  foldRecord,
  normalizeJoysoundNumber,
  parseArgs,
  serializeIndex,
} from './build-joysound-artist-id-index.mjs';

const fakeDeps = {
  normalizeForMatch: (s) => String(s).replace(/\s+/g, '').toLowerCase(),
  splitArtistCollab: (s) => {
    const whole = String(s).trim();
    if (whole === '') return [];
    const parts = [whole, ...whole.split('&').map((p) => p.trim())];
    return [...new Set(parts.filter((p) => p !== ''))];
  },
};

const silent = { log() {}, error() {} };

describe('normalizeJoysoundNumber', () => {
  it('strips hyphens to the dashless corpus form', () => {
    expect(normalizeJoysoundNumber('190-001')).toBe('190001');
    expect(normalizeJoysoundNumber('622657')).toBe('622657');
  });

  it('returns null for a non-digits value', () => {
    expect(normalizeJoysoundNumber('abc')).toBe(null);
    expect(normalizeJoysoundNumber('')).toBe(null);
    expect(normalizeJoysoundNumber(null)).toBe(null);
  });
});

describe('foldRecord', () => {
  it('maps a number to its artistId and every artist component to that id', () => {
    const acc = createAccumulator();
    foldRecord(
      acc,
      { detail: { selSongNo: '622657', artistId: '43832', artistName: 'いきものがかり' } },
      fakeDeps,
    );
    expect(acc.joysoundNumberToArtistId.get('622657')).toBe('43832');
    expect(acc.artistNameToArtistIds.get('いきものがかり')).toEqual(new Set(['43832']));
    expect(acc.recordsWithArtistId).toBe(1);
  });

  it('splits collab artists and normalises hyphenated numbers', () => {
    const acc = createAccumulator();
    foldRecord(
      acc,
      { detail: { selSongNo: '190-001', artistId: 'X', artistName: 'A & B' } },
      fakeDeps,
    );
    expect(acc.joysoundNumberToArtistId.get('190001')).toBe('X');
    // whole + each component all key to the same id.
    expect(acc.artistNameToArtistIds.get('a')).toEqual(new Set(['X']));
    expect(acc.artistNameToArtistIds.get('b')).toEqual(new Set(['X']));
    expect(acc.artistNameToArtistIds.get('a&b')).toEqual(new Set(['X']));
  });

  it('coerces a numeric artistId to a string', () => {
    const acc = createAccumulator();
    foldRecord(acc, { detail: { selSongNo: '5', artistId: 43832, artistName: 'N' } }, fakeDeps);
    expect(acc.joysoundNumberToArtistId.get('5')).toBe('43832');
  });

  it('skips records with no detail or no artistId', () => {
    const acc = createAccumulator();
    foldRecord(acc, { detailFetchFailed: true }, fakeDeps); // no detail
    foldRecord(acc, { detail: { selSongNo: '9', artistId: null, artistName: 'Z' } }, fakeDeps);
    foldRecord(acc, { detail: { selSongNo: '9', artistName: 'Z' } }, fakeDeps); // missing artistId
    expect(acc.recordsWithArtistId).toBe(0);
    expect(acc.joysoundNumberToArtistId.size).toBe(0);
    expect(acc.artistNameToArtistIds.size).toBe(0);
  });

  it('is first-seen-wins on a number and counts conflicts', () => {
    const acc = createAccumulator();
    foldRecord(acc, { detail: { selSongNo: '100', artistId: 'A', artistName: 'x' } }, fakeDeps);
    foldRecord(acc, { detail: { selSongNo: '100', artistId: 'B', artistName: 'y' } }, fakeDeps);
    expect(acc.joysoundNumberToArtistId.get('100')).toBe('A');
    expect(acc.numberConflicts).toBe(1);
  });

  it('accumulates multiple artistIds under one artist key', () => {
    const acc = createAccumulator();
    foldRecord(acc, { detail: { selSongNo: '1', artistId: 'A', artistName: 'dup' } }, fakeDeps);
    foldRecord(acc, { detail: { selSongNo: '2', artistId: 'B', artistName: 'dup' } }, fakeDeps);
    expect(acc.artistNameToArtistIds.get('dup')).toEqual(new Set(['A', 'B']));
  });
});

describe('serializeIndex', () => {
  it('sorts keys and id arrays for byte-stable output', () => {
    const acc = createAccumulator();
    foldRecord(acc, { detail: { selSongNo: '2', artistId: 'B', artistName: 'z' } }, fakeDeps);
    foldRecord(acc, { detail: { selSongNo: '1', artistId: 'A', artistName: 'a' } }, fakeDeps);
    foldRecord(acc, { detail: { selSongNo: '3', artistId: 'A', artistName: 'a' } }, fakeDeps);
    const out = serializeIndex(acc, { note: 'meta' });
    expect(Object.keys(out.joysoundNumberToArtistId)).toEqual(['1', '2', '3']);
    expect(Object.keys(out.artistNameToArtistIds)).toEqual(['a', 'z']);
    // 'a' was credited under A (numbers 1 and 3) -> single id, sorted array.
    expect(out.artistNameToArtistIds.a).toEqual(['A']);
    expect(out._meta).toEqual({ note: 'meta' });
  });
});

describe('buildIndex (streamed end-to-end)', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artistid-index-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams a JSONL log, skips blank/malformed lines, and writes the sorted index', async () => {
    const logPath = join(dir, 'log.jsonl');
    const outPath = join(dir, 'index.json');
    const lines = [
      JSON.stringify({ detail: { selSongNo: '622657', artistId: '43832', artistName: 'A' } }),
      '', // blank line — skipped
      '{ not json', // malformed — counted, skipped
      JSON.stringify({ detailFetchFailed: true }), // no detail — no contribution
      JSON.stringify({ detail: { selSongNo: '100', artistId: '77', artistName: 'B & C' } }),
    ];
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const code = await buildIndex({ logPath, outPath, deps: fakeDeps, log: silent });
    expect(code).toBe(0);

    const out = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(out.joysoundNumberToArtistId).toEqual({ 100: '77', 622657: '43832' });
    expect(out.artistNameToArtistIds.a).toEqual(['43832']);
    expect(out.artistNameToArtistIds.b).toEqual(['77']);
    expect(out.artistNameToArtistIds.c).toEqual(['77']);
    expect(out._meta.lines).toBe(4); // 4 non-blank lines (malformed + no-detail count)
    expect(out._meta.parseErrors).toBe(1);
    expect(out._meta.recordsWithArtistId).toBe(2);
    expect(out._meta.joysoundNumbers).toBe(2);
  });

  it('returns 2 when the log file is missing', async () => {
    const code = await buildIndex({
      logPath: join(dir, 'nope.jsonl'),
      outPath: join(dir, 'out.json'),
      deps: fakeDeps,
      log: silent,
    });
    expect(code).toBe(2);
  });
});

describe('parseArgs', () => {
  it('takes a positional log path and optional --out', () => {
    expect(parseArgs(['log.jsonl', '--out', 'idx.json'])).toEqual({
      logPath: 'log.jsonl',
      outPath: 'idx.json',
      help: false,
    });
  });

  it('requires a log path and rejects unknown flags / extras', () => {
    expect(() => parseArgs([])).toThrow(/detail-log JSONL path is required/);
    expect(() => parseArgs(['a.jsonl', '--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['a.jsonl', 'b.jsonl'])).toThrow(/unexpected extra argument/);
  });
});
