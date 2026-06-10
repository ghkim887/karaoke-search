// Tests for scripts/lib/manifest.mjs — the shared full-corpus manifest
// implementation (streaming sha256, shape validation, read/write round-trip)
// used by publish-full-corpus.mjs and fetch-full-corpus.mjs.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MANIFEST_VERSION,
  PENDING_URL,
  assetUrlProblem,
  hashFile,
  readManifest,
  validateManifest,
  writeManifestAtomic,
} from './lib/manifest.mjs';

function validManifest(overrides = {}) {
  return {
    version: MANIFEST_VERSION,
    url: 'https://example.com/releases/full-corpus.json',
    sha256: 'a'.repeat(64),
    sizeBytes: 1234,
    recordCount: 42,
    vendorCounts: { joysound: 40, ky: 10, tj: 30 },
    generatedAt: '2026-06-10T00:00:00.000Z',
    baselineCommit: 'ed8bee2c0ffee0000000000000000000000000ab',
    ...overrides,
  };
}

describe('hashFile', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-lib-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the streaming sha256 and exact byte size', async () => {
    const path = join(dir, 'fixture.json');
    const content = '[{"hello":"world"}]\n';
    writeFileSync(path, content, 'utf-8');

    const { sha256, sizeBytes } = await hashFile(path);
    expect(sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(sizeBytes).toBe(Buffer.byteLength(content));
  });

  it('rejects on a missing file', async () => {
    await expect(hashFile(join(dir, 'absent.json'))).rejects.toThrow(/ENOENT/);
  });
});

describe('assetUrlProblem', () => {
  it('accepts PENDING, http(s), and file urls', () => {
    expect(assetUrlProblem(PENDING_URL)).toBeNull();
    expect(assetUrlProblem('https://example.com/a.json')).toBeNull();
    expect(assetUrlProblem('http://example.com/a.json')).toBeNull();
    expect(assetUrlProblem('file:///C:/tmp/a.json')).toBeNull();
  });

  it('describes the problem for empty, unparseable, and wrong-protocol urls', () => {
    expect(assetUrlProblem('')).toMatch(/non-empty string/);
    expect(assetUrlProblem(undefined)).toMatch(/non-empty string/);
    expect(assetUrlProblem('not a url')).toMatch(/not a valid URL/);
    expect(assetUrlProblem('ftp://example.com/a.json')).toMatch(/protocol must be/);
  });
});

describe('validateManifest', () => {
  it('accepts a valid manifest, with and without decisionLogSha', () => {
    expect(() => validateManifest(validManifest())).not.toThrow();
    expect(() => validateManifest(validManifest({ decisionLogSha: 'b'.repeat(64) }))).not.toThrow();
  });

  it('accepts the PENDING placeholder url and file:// urls', () => {
    expect(() => validateManifest(validManifest({ url: PENDING_URL }))).not.toThrow();
    expect(() =>
      validateManifest(validManifest({ url: 'file:///C:/tmp/full-corpus.json' })),
    ).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateManifest(null)).toThrow(/expected a JSON object/);
    expect(() => validateManifest([validManifest()])).toThrow(/expected a JSON object/);
  });

  it('pins the version', () => {
    expect(() => validateManifest(validManifest({ version: 2 }))).toThrow(/version must be 1/);
    expect(() => validateManifest(validManifest({ version: '1' }))).toThrow(/version must be 1/);
  });

  it('rejects malformed urls and disallowed protocols', () => {
    expect(() => validateManifest(validManifest({ url: '' }))).toThrow(/non-empty string/);
    expect(() => validateManifest(validManifest({ url: 'not a url' }))).toThrow(/not a valid URL/);
    expect(() => validateManifest(validManifest({ url: 'ftp://example.com/x' }))).toThrow(
      /protocol must be/,
    );
  });

  it('rejects malformed sha256 / sizeBytes / recordCount', () => {
    expect(() => validateManifest(validManifest({ sha256: 'A'.repeat(64) }))).toThrow(/sha256/);
    expect(() => validateManifest(validManifest({ sha256: 'a'.repeat(63) }))).toThrow(/sha256/);
    expect(() => validateManifest(validManifest({ sizeBytes: 0 }))).toThrow(/sizeBytes/);
    expect(() => validateManifest(validManifest({ sizeBytes: 12.5 }))).toThrow(/sizeBytes/);
    expect(() => validateManifest(validManifest({ recordCount: 0 }))).toThrow(/recordCount/);
  });

  it('rejects bad vendorCounts values and bad commit shas', () => {
    expect(() => validateManifest(validManifest({ vendorCounts: { tj: -1 } }))).toThrow(
      /vendorCounts\.tj/,
    );
    expect(() => validateManifest(validManifest({ vendorCounts: null }))).toThrow(
      /vendorCounts must be an object/,
    );
    expect(() => validateManifest(validManifest({ baselineCommit: 'main' }))).toThrow(
      /baselineCommit/,
    );
    expect(() => validateManifest(validManifest({ decisionLogSha: 'nope' }))).toThrow(
      /decisionLogSha/,
    );
  });

  it('rejects unknown keys (typo guard)', () => {
    expect(() => validateManifest(validManifest({ shaa256: 'x' }))).toThrow(
      /unknown key "shaa256"/,
    );
  });

  it('collects every problem in one error', () => {
    expect(() => validateManifest({ version: 9, url: '' })).toThrow(
      /version must be 1[\s\S]*url must be[\s\S]*sha256/,
    );
  });
});

describe('readManifest / writeManifestAtomic', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'manifest-rw-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips: write then read returns an equal validated manifest', () => {
    const path = join(dir, 'manifest.json');
    const manifest = validManifest({ decisionLogSha: 'c'.repeat(64) });
    writeManifestAtomic(path, manifest);
    expect(readManifest(path)).toEqual(manifest);
  });

  it('writes the canonical byte-shape (indent=2, trailing newline, no .tmp left)', () => {
    const path = join(dir, 'manifest.json');
    const manifest = validManifest();
    writeManifestAtomic(path, manifest);
    expect(readFileSync(path, 'utf-8')).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => statSync(`${path}.tmp`)).toThrow();
  });

  it('refuses to write an invalid manifest (no file created)', () => {
    const path = join(dir, 'manifest.json');
    expect(() => writeManifestAtomic(path, validManifest({ version: 99 }))).toThrow(
      /version must be 1/,
    );
    expect(() => statSync(path)).toThrow();
  });

  it('readManifest fails clearly on a missing file, bad JSON, and bad shape', () => {
    expect(() => readManifest(join(dir, 'absent.json'))).toThrow(/cannot read/);

    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{ nope', 'utf-8');
    expect(() => readManifest(badJson)).toThrow(/not valid JSON/);

    const badShape = join(dir, 'bad-shape.json');
    writeFileSync(badShape, JSON.stringify(validManifest({ sizeBytes: -5 })), 'utf-8');
    expect(() => readManifest(badShape)).toThrow(/sizeBytes/);
  });
});
