// Tests for scripts/publish-full-corpus.mjs — schema-validate a composed
// corpus and emit the tracked full-corpus manifest. Uses the REAL
// validateSongRecord from @karaoke/schema (the @karaoke/scripts test script
// builds the crawler first, which builds the referenced schema project, so
// dist is always present here).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSongRecord } from '@karaoke/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashFile, readManifest } from './lib/manifest.mjs';
import {
  USAGE,
  computeVendorCounts,
  parseArgs,
  runPublishFullCorpus,
} from './publish-full-corpus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, 'publish-full-corpus.mjs');
const NODE = process.execPath;

const quietLog = { log: () => {}, error: () => {} };
const FAKE_SHA = 'ed8bee2c0ffee0000000000000000000000000ab';

/** Minimal schema-VALID record (passes the real validateSongRecord). */
function record(id, numbers = {}) {
  return {
    id,
    source_url: `https://example.com/${id}`,
    title_primary: '夜に駆ける',
    title_ko: null,
    artist_primary: 'YOASOBI',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null, ...numbers },
    crawled_at: '2026-01-01T00:00:00+00:00',
  };
}

function writeCorpus(path, records) {
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

describe('parseArgs', () => {
  it('requires --input and --url', () => {
    expect(() => parseArgs([])).toThrow(/--input .* is required/);
    expect(() => parseArgs(['--input', 'c.json'])).toThrow(/--url .* is required/);
  });

  it('defaults --manifest-out to the tracked data/ location', () => {
    const parsed = parseArgs(['--input', 'c.json', '--url', 'PENDING']);
    expect(parsed.manifestOut.replace(/\\/g, '/')).toMatch(/data\/full-corpus\.manifest\.json$/);
  });

  it('accepts every documented flag', () => {
    const parsed = parseArgs([
      '--input',
      'c.json',
      '--url',
      'https://example.com/a.json',
      '--manifest-out',
      'm.json',
      '--baseline-commit',
      FAKE_SHA,
      '--decision-log',
      'log.ndjson',
      '--sqlite-out',
      'c.sqlite',
    ]);
    expect(parsed).toEqual({
      inputPath: 'c.json',
      url: 'https://example.com/a.json',
      manifestOut: 'm.json',
      baselineCommit: FAKE_SHA,
      decisionLogPath: 'log.ndjson',
      sqliteOut: 'c.sqlite',
      searchHintPaths: [],
      help: false,
    });
  });

  it('collects repeatable --search-hints paths', () => {
    const parsed = parseArgs([
      '--input',
      'c.json',
      '--url',
      'PENDING',
      '--search-hints',
      'a.jsonl',
      '--search-hints',
      'b.jsonl',
    ]);
    expect(parsed.searchHintPaths).toEqual(['a.jsonl', 'b.jsonl']);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--input'])).toThrow(/requires a value/);
  });

  it('fails fast on a malformed --url (before any validation pass is paid)', () => {
    expect(() => parseArgs(['--input', 'c.json', '--url', 'not a url'])).toThrow(
      /--url is not a valid URL/,
    );
    expect(() => parseArgs(['--input', 'c.json', '--url', 'ftp://example.com/x'])).toThrow(
      /--url protocol must be/,
    );
    // PENDING and file:// stay acceptable.
    expect(parseArgs(['--input', 'c.json', '--url', 'PENDING']).url).toBe('PENDING');
    expect(parseArgs(['--input', 'c.json', '--url', 'file:///C:/x.json']).url).toBe(
      'file:///C:/x.json',
    );
  });

  it('allows --help without required flags', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('computeVendorCounts', () => {
  it('counts non-null numbers per vendor with sorted keys', () => {
    const counts = computeVendorCounts([
      record('blog-1', { tj: '1', joysound: '100' }),
      record('blog-2', { tj: '2' }),
      record('blog-3', { ky: '3' }),
    ]);
    expect(counts).toEqual({ joysound: 1, ky: 1, tj: 2 });
    expect(Object.keys(counts)).toEqual(['joysound', 'ky', 'tj']);
  });
});

describe('runPublishFullCorpus', () => {
  let dir;
  let corpusPath;
  let manifestPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-full-corpus-'));
    corpusPath = join(dir, 'full-corpus.json');
    manifestPath = join(dir, 'manifest.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function publish(extra = {}) {
    return runPublishFullCorpus({
      inputPath: corpusPath,
      manifestOut: manifestPath,
      url: 'PENDING',
      baselineCommit: FAKE_SHA,
      validate: validateSongRecord,
      log: quietLog,
      ...extra,
    });
  }

  it('round-trip: publishes a manifest with correct sha/size/counts', async () => {
    writeCorpus(corpusPath, [
      record('blog-1', { tj: '68425', joysound: '190001' }),
      record('blog-2', { ky: '44444' }),
      record('tj-3', { tj: '12345' }),
    ]);
    expect(await publish()).toBe(0);

    const manifest = readManifest(manifestPath);
    const expected = await hashFile(corpusPath);
    expect(manifest.version).toBe(1);
    expect(manifest.url).toBe('PENDING');
    expect(manifest.sha256).toBe(expected.sha256);
    expect(manifest.sizeBytes).toBe(expected.sizeBytes);
    expect(manifest.recordCount).toBe(3);
    expect(manifest.vendorCounts).toEqual({ joysound: 1, ky: 1, tj: 2 });
    expect(manifest.baselineCommit).toBe(FAKE_SHA);
    expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
    expect(manifest.decisionLogSha).toBeUndefined();
  });

  it('rejects an invalid record with the validation summary; no manifest written', async () => {
    const broken = record('blog-9');
    broken.karaoke_numbers.joysound = '등록일'; // schema pattern ^[0-9]+$ violation
    writeCorpus(corpusPath, [record('blog-1'), broken]);

    const errors = [];
    const code = await publish({ log: { log: () => {}, error: (msg) => errors.push(msg) } });
    expect(code).toBe(1);
    expect(existsSync(manifestPath)).toBe(false);
    expect(errors.some((l) => String(l).includes('Validation failures: 1 / 2'))).toBe(true);
    expect(errors.some((l) => String(l).includes('Failure summary'))).toBe(true);
  });

  it('rejects an empty corpus and a missing input', async () => {
    writeCorpus(corpusPath, []);
    expect(await publish()).toBe(2);
    expect(existsSync(manifestPath)).toBe(false);

    expect(await publish({ inputPath: join(dir, 'absent.json') })).toBe(2);
  });

  it('rejects a malformed url with exit 2 on the programmatic path too', async () => {
    writeCorpus(corpusPath, [record('blog-1')]);
    expect(await publish({ url: 'ftp://example.com/x' })).toBe(2);
    expect(await publish({ url: 'not a url' })).toBe(2);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('includes decisionLogSha when --decision-log is given', async () => {
    writeCorpus(corpusPath, [record('blog-1')]);
    const logPath = join(dir, 'decision-log.ndjson');
    writeFileSync(logPath, '{"decision":"admit"}\n', 'utf-8');

    expect(await publish({ decisionLogPath: logPath })).toBe(0);
    const manifest = readManifest(manifestPath);
    expect(manifest.decisionLogSha).toBe((await hashFile(logPath)).sha256);
  });

  it('fails fast on a missing decision log', async () => {
    writeCorpus(corpusPath, [record('blog-1')]);
    expect(await publish({ decisionLogPath: join(dir, 'absent.ndjson') })).toBe(2);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('builds the SQLite DB through the injected builder when --sqlite-out is given', async () => {
    writeCorpus(corpusPath, [record('blog-1')]);
    const calls = [];
    const sqlitePath = join(dir, 'corpus.sqlite');
    const code = await publish({
      sqliteOut: sqlitePath,
      buildSqlite: async (args) => {
        calls.push(args);
        return { ...args, bytes: 4096 };
      },
    });
    expect(code).toBe(0);
    expect(calls).toEqual([{ inputPath: corpusPath, outputPath: sqlitePath, searchHintPaths: [] }]);
  });

  it('a failing SQLite build fails the publish (manifest already written is fine — it is still valid)', async () => {
    writeCorpus(corpusPath, [record('blog-1')]);
    const code = await publish({
      sqliteOut: join(dir, 'corpus.sqlite'),
      buildSqlite: async () => {
        throw new Error('boom');
      },
    });
    expect(code).toBe(1);
  });
});

describe('CLI (real process)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-full-corpus-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes end-to-end via the real CLI (PENDING dry-run url)', async () => {
    const corpusPath = join(dir, 'full-corpus.json');
    const manifestPath = join(dir, 'manifest.json');
    writeCorpus(corpusPath, [record('blog-1', { tj: '68425' })]);

    const res = spawnSync(
      NODE,
      [
        SCRIPT_PATH,
        '--input',
        corpusPath,
        '--url',
        'PENDING',
        '--manifest-out',
        manifestPath,
        '--baseline-commit',
        FAKE_SHA,
      ],
      { encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Records:      1 (all schema-valid)');
    expect(res.stdout).toContain('dry-run manifest');
    expect(readManifest(manifestPath).recordCount).toBe(1);
  });

  it('exits 2 with usage on missing required flags', () => {
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
