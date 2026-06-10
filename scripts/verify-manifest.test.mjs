// Tests for scripts/verify-manifest.mjs — the cheap per-PR CI gate that
// shape-validates the tracked full-corpus manifest without downloading the
// corpus asset (PENDING urls rejected unless --allow-pending).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST_PATH,
  MANIFEST_VERSION,
  PENDING_URL,
  writeManifestAtomic,
} from './lib/manifest.mjs';
import { parseArgs, runVerifyManifest } from './verify-manifest.mjs';

function validManifest(overrides = {}) {
  return {
    version: MANIFEST_VERSION,
    url: 'https://github.com/ghkim887/karaoke-search/releases/download/data-test/full-corpus.json',
    sha256: 'a'.repeat(64),
    sizeBytes: 1234,
    recordCount: 42,
    vendorCounts: { joysound: 40, ky: 10, tj: 30 },
    generatedAt: '2026-06-10T00:00:00.000Z',
    baselineCommit: 'ed8bee2c0ffee0000000000000000000000000ab',
    ...overrides,
  };
}

function makeLog() {
  const lines = { out: [], err: [] };
  return {
    lines,
    log: (msg) => lines.out.push(String(msg)),
    error: (msg) => lines.err.push(String(msg)),
  };
}

describe('parseArgs', () => {
  it('defaults to the tracked manifest path with pending disallowed', () => {
    expect(parseArgs([])).toEqual({
      manifestPath: DEFAULT_MANIFEST_PATH,
      allowPending: false,
      help: false,
    });
  });

  it('parses --manifest, --allow-pending, and --help', () => {
    expect(parseArgs(['--manifest', 'x.json', '--allow-pending'])).toEqual({
      manifestPath: 'x.json',
      allowPending: true,
      help: false,
    });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown arguments and a valueless --manifest', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument: --nope/);
    expect(() => parseArgs(['--manifest'])).toThrow(/--manifest requires a value/);
    expect(() => parseArgs(['--manifest', '--allow-pending'])).toThrow(
      /--manifest requires a value/,
    );
  });
});

describe('runVerifyManifest', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-manifest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns 0 and summarizes a valid published manifest', () => {
    const path = join(dir, 'manifest.json');
    writeManifestAtomic(path, validManifest());
    const log = makeLog();

    expect(runVerifyManifest({ manifestPath: path, log })).toBe(0);
    expect(log.lines.out.join('\n')).toMatch(/manifest OK/);
    expect(log.lines.out.join('\n')).toMatch(/records: 42/);
    expect(log.lines.err).toEqual([]);
  });

  it('rejects a PENDING url by default but accepts it with allowPending', () => {
    const path = join(dir, 'manifest.json');
    writeManifestAtomic(path, validManifest({ url: PENDING_URL }));

    const strict = makeLog();
    expect(runVerifyManifest({ manifestPath: path, log: strict })).toBe(1);
    expect(strict.lines.err.join('\n')).toMatch(/PENDING/);
    expect(strict.lines.err.join('\n')).toMatch(/--allow-pending/);

    const lenient = makeLog();
    expect(runVerifyManifest({ manifestPath: path, allowPending: true, log: lenient })).toBe(0);
    expect(lenient.lines.out.join('\n')).toMatch(/manifest OK/);
  });

  it('returns 1 on a missing manifest file', () => {
    const log = makeLog();
    expect(runVerifyManifest({ manifestPath: join(dir, 'absent.json'), log })).toBe(1);
    expect(log.lines.err.join('\n')).toMatch(/cannot read/);
  });

  it('returns 1 on unparseable JSON and on an invalid shape', () => {
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{ nope', 'utf-8');
    const jsonLog = makeLog();
    expect(runVerifyManifest({ manifestPath: badJson, log: jsonLog })).toBe(1);
    expect(jsonLog.lines.err.join('\n')).toMatch(/not valid JSON/);

    const badShape = join(dir, 'bad-shape.json');
    writeFileSync(badShape, JSON.stringify(validManifest({ sizeBytes: -5 })), 'utf-8');
    const shapeLog = makeLog();
    expect(runVerifyManifest({ manifestPath: badShape, log: shapeLog })).toBe(1);
    expect(shapeLog.lines.err.join('\n')).toMatch(/sizeBytes/);
  });
});
