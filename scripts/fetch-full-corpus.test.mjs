// Tests for scripts/fetch-full-corpus.mjs — manifest-driven download with
// sha256+size verification BEFORE the atomic rename. file:// URLs back the
// fixtures so no HTTP server is needed (and the future store swap is proven
// to be just a url change).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_MS, USAGE, parseArgs, runFetchFullCorpus } from './fetch-full-corpus.mjs';
import { hashFile, writeManifestAtomic } from './lib/manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, 'fetch-full-corpus.mjs');
const NODE = process.execPath;

const quietLog = { log: () => {}, error: () => {} };
const FAKE_SHA = 'ed8bee2c0ffee0000000000000000000000000ab';
const CORPUS_CONTENT = `${JSON.stringify([{ id: 'blog-1', title_primary: '夜に駆ける' }], null, 2)}\n`;

/** True when the out file's directory holds no leftover *.tmp (any suffix). */
function noTmpLeft(outPath) {
  const parent = dirname(outPath);
  if (!existsSync(parent)) return true;
  return readdirSync(parent).every((name) => !name.endsWith('.tmp'));
}

describe('parseArgs', () => {
  it('requires --out', () => {
    expect(() => parseArgs([])).toThrow(/--out .* is required/);
  });

  it('defaults --manifest to the tracked data/ location', () => {
    const parsed = parseArgs(['--out', 'c.json']);
    expect(parsed.manifestPath.replace(/\\/g, '/')).toMatch(/data\/full-corpus\.manifest\.json$/);
    expect(parsed.skipIfValid).toBe(false);
  });

  it('accepts --manifest, --skip-download-if-valid, --help', () => {
    const parsed = parseArgs([
      '--manifest',
      'm.json',
      '--out',
      'c.json',
      '--skip-download-if-valid',
    ]);
    expect(parsed).toEqual({
      manifestPath: 'm.json',
      outPath: 'c.json',
      skipIfValid: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      help: false,
    });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('defaults --timeout-ms to 10 minutes and accepts an override', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(600_000);
    expect(parseArgs(['--out', 'c.json']).timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(parseArgs(['--out', 'c.json', '--timeout-ms', '5000']).timeoutMs).toBe(5000);
  });

  it('rejects a non-positive or non-numeric --timeout-ms', () => {
    expect(() => parseArgs(['--out', 'c.json', '--timeout-ms', '0'])).toThrow(
      /--timeout-ms must be a positive integer/,
    );
    expect(() => parseArgs(['--out', 'c.json', '--timeout-ms', 'soon'])).toThrow(
      /--timeout-ms must be a positive integer/,
    );
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--out', 'c.json', '--frobnicate'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--out'])).toThrow(/requires a value/);
  });
});

describe('runFetchFullCorpus', () => {
  let dir;
  let sourcePath;
  let manifestPath;
  let outPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fetch-full-corpus-'));
    sourcePath = join(dir, 'source.json');
    manifestPath = join(dir, 'manifest.json');
    outPath = join(dir, 'out', 'corpus.json');
    writeFileSync(sourcePath, CORPUS_CONTENT, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a manifest pointing at the file:// fixture, with overridable fields. */
  async function writeFixtureManifest(overrides = {}) {
    const { sha256, sizeBytes } = await hashFile(sourcePath);
    writeManifestAtomic(manifestPath, {
      version: 1,
      url: pathToFileURL(sourcePath).href,
      sha256,
      sizeBytes,
      recordCount: 1,
      vendorCounts: { joysound: 0, ky: 0, tj: 0 },
      generatedAt: '2026-06-10T00:00:00.000Z',
      baselineCommit: FAKE_SHA,
      ...overrides,
    });
  }

  function fetchCorpus(extra = {}) {
    return runFetchFullCorpus({ manifestPath, outPath, log: quietLog, ...extra });
  }

  it('downloads via file://, verifies, and writes atomically (no .tmp left)', async () => {
    await writeFixtureManifest();
    expect(await fetchCorpus()).toBe(0);
    expect(readFileSync(outPath, 'utf-8')).toBe(CORPUS_CONTENT);
    expect(noTmpLeft(outPath)).toBe(true);
  });

  it('rejects a sha256 mismatch, deleting the tmp and leaving no output', async () => {
    await writeFixtureManifest({ sha256: '0'.repeat(64) });
    const errors = [];
    const code = await fetchCorpus({ log: { log: () => {}, error: (m) => errors.push(m) } });
    expect(code).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(noTmpLeft(outPath)).toBe(true);
    expect(errors.some((l) => String(l).includes('does not match the manifest'))).toBe(true);
    expect(errors.some((l) => String(l).includes('sha256 expected'))).toBe(true);
  });

  it('rejects a sizeBytes mismatch the same way', async () => {
    const { sizeBytes } = await hashFile(sourcePath);
    await writeFixtureManifest({ sizeBytes: sizeBytes + 1 });
    expect(await fetchCorpus()).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(noTmpLeft(outPath)).toBe(true);
  });

  it('a sha-mismatch failure never tears an existing valid output file', async () => {
    await writeFixtureManifest();
    expect(await fetchCorpus()).toBe(0);

    // Manifest now disagrees with the source — refetch must fail AND leave
    // the previously fetched valid file untouched.
    await writeFixtureManifest({ sha256: '0'.repeat(64) });
    expect(await fetchCorpus()).toBe(1);
    expect(readFileSync(outPath, 'utf-8')).toBe(CORPUS_CONTENT);
  });

  it('--skip-download-if-valid no-ops when the output already matches (idempotent)', async () => {
    await writeFixtureManifest();
    expect(await fetchCorpus()).toBe(0);
    const mtimeBefore = statSync(outPath).mtimeMs;

    // Point the manifest url at a nonexistent file: if the second run tried
    // to download at all it would fail — returning 0 proves the no-op.
    await writeFixtureManifest({ url: pathToFileURL(join(dir, 'gone.json')).href });
    await new Promise((r) => setTimeout(r, 50));
    expect(await fetchCorpus({ skipIfValid: true })).toBe(0);
    expect(statSync(outPath).mtimeMs).toBe(mtimeBefore);
    expect(readFileSync(outPath, 'utf-8')).toBe(CORPUS_CONTENT);
  });

  it('--skip-download-if-valid re-downloads when the existing output is stale', async () => {
    await writeFixtureManifest();
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, 'stale bytes', 'utf-8');

    expect(await fetchCorpus({ skipIfValid: true })).toBe(0);
    expect(readFileSync(outPath, 'utf-8')).toBe(CORPUS_CONTENT);
  });

  it('refuses a PENDING-url manifest with a clear message', async () => {
    await writeFixtureManifest({ url: 'PENDING' });
    const errors = [];
    const code = await fetchCorpus({ log: { log: () => {}, error: (m) => errors.push(m) } });
    expect(code).toBe(2);
    expect(existsSync(outPath)).toBe(false);
    expect(errors.some((l) => String(l).includes('PENDING'))).toBe(true);
    expect(errors.some((l) => String(l).includes('no published asset yet'))).toBe(true);
  });

  it('fails clearly on a missing or shape-invalid manifest', async () => {
    expect(await fetchCorpus({ manifestPath: join(dir, 'absent.json') })).toBe(2);

    writeFileSync(manifestPath, JSON.stringify({ version: 2 }), 'utf-8');
    expect(await fetchCorpus()).toBe(2);
  });

  it('a failed download (missing source) leaves no tmp file', async () => {
    await writeFixtureManifest({ url: pathToFileURL(join(dir, 'gone.json')).href });
    expect(await fetchCorpus()).toBe(1);
    expect(existsSync(outPath)).toBe(false);
    expect(noTmpLeft(outPath)).toBe(true);
  });
});

describe('CLI (real process)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fetch-full-corpus-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fetches end-to-end via the real CLI', async () => {
    const sourcePath = join(dir, 'source.json');
    const manifestPath = join(dir, 'manifest.json');
    const outPath = join(dir, 'corpus.json');
    writeFileSync(sourcePath, CORPUS_CONTENT, 'utf-8');
    const { sha256, sizeBytes } = await hashFile(sourcePath);
    writeManifestAtomic(manifestPath, {
      version: 1,
      url: pathToFileURL(sourcePath).href,
      sha256,
      sizeBytes,
      recordCount: 1,
      vendorCounts: { tj: 0 },
      generatedAt: '2026-06-10T00:00:00.000Z',
      baselineCommit: FAKE_SHA,
    });

    const res = spawnSync(NODE, [SCRIPT_PATH, '--manifest', manifestPath, '--out', outPath], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('(verified)');
    expect(readFileSync(outPath, 'utf-8')).toBe(CORPUS_CONTENT);
  });

  it('exits 2 with usage on a missing --out', () => {
    const res = spawnSync(NODE, [SCRIPT_PATH], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(USAGE);
  });

  it('exits 0 on --help and prints usage', () => {
    const res = spawnSync(NODE, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
  });
});
