#!/usr/bin/env node
/**
 * publish-full-corpus.mjs — validate a composed full corpus and emit the
 * tracked manifest that describes it (PR-1 of the post-JOYSOUND data
 * topology: corpus lives outside git as a release asset; git tracks only
 * this manifest — see docs/ROADMAP.md item 1).
 *
 * INPUT-DECOUPLED by design: corpus composition happens elsewhere (the
 * JOYSOUND candidate builder on its feature branch); this script takes any
 * already-composed corpus JSON via --input and has no dependency on how it
 * was produced.
 *
 * Pipeline: load → schema-validate every record (same gate style as
 * validate-songs-json.mjs) → streaming sha256 + record/vendor counts →
 * atomic manifest write → optional SQLite build (reuses the worker's
 * build-sqlite-db.mjs).
 *
 * The actual upload + workflow wiring is PR-2/PR-3; `--url PENDING` lets
 * dry-runs produce a manifest before any release asset exists (the fetcher
 * refuses PENDING manifests).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus, loadValidator } from './lib/corpus.mjs';
import {
  DEFAULT_MANIFEST_PATH,
  MANIFEST_VERSION,
  PENDING_URL,
  assetUrlProblem,
  hashFile,
  writeManifestAtomic,
} from './lib/manifest.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const BUILD_SQLITE_PATH = resolve(REPO_ROOT, 'apps/worker/scripts/build-sqlite-db.mjs');

export const USAGE = [
  'usage: node scripts/publish-full-corpus.mjs --input <full-corpus.json> --url <asset-url|PENDING> [options]',
  '',
  'Validates a composed corpus and writes the tracked full-corpus manifest.',
  '',
  'options:',
  '  --input <path>            composed corpus JSON (required)',
  `  --url <url>               release-asset URL, or ${PENDING_URL} for dry-runs (required)`,
  '  --manifest-out <path>     manifest destination (default: data/full-corpus.manifest.json)',
  '  --baseline-commit <sha>   git sha the corpus was composed against (default: git rev-parse HEAD)',
  '  --decision-log <path>     include this file’s sha256 as decisionLogSha',
  '  --sqlite-out <path>       also build the SQLite DB via apps/worker/scripts/build-sqlite-db.mjs',
  '  --search-hints <path>     search-only hint sidecar (repeatable); indexed into title_hint/artist_hint tokens',
  '  --help                    show this message',
  '',
  'exit codes: 0 ok · 1 validation/build failure · 2 bad arguments or missing input',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {{ inputPath: string|null, url: string|null, manifestOut: string,
 *             baselineCommit: string|null, decisionLogPath: string|null,
 *             sqliteOut: string|null, searchHintPaths: string[], help: boolean }}
 */
export function parseArgs(argv) {
  const parsed = {
    inputPath: null,
    url: null,
    manifestOut: DEFAULT_MANIFEST_PATH,
    baselineCommit: null,
    decisionLogPath: null,
    sqliteOut: null,
    searchHintPaths: [],
    help: false,
  };
  const valueFlags = new Map([
    ['--input', 'inputPath'],
    ['--url', 'url'],
    ['--manifest-out', 'manifestOut'],
    ['--baseline-commit', 'baselineCommit'],
    ['--decision-log', 'decisionLogPath'],
    ['--sqlite-out', 'sqliteOut'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      parsed.help = true;
      continue;
    }
    // Repeatable, so not a single-value flag in the valueFlags map.
    if (arg === '--search-hints') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      parsed.searchHintPaths.push(value);
      i += 1;
      continue;
    }
    const key = valueFlags.get(arg);
    if (key === undefined) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    parsed[key] = value;
    i += 1;
  }
  if (parsed.help) {
    return parsed;
  }
  if (parsed.inputPath === null) {
    throw new Error('--input <full-corpus.json> is required');
  }
  if (parsed.url === null) {
    throw new Error(`--url <asset-url|${PENDING_URL}> is required`);
  }
  // Fail fast on a malformed url here (exit 2, with usage) instead of at
  // manifest-write time — by then a full 221k-record validation pass has
  // already been paid.
  const urlProblem = assetUrlProblem(parsed.url);
  if (urlProblem !== null) {
    throw new Error(`--url ${urlProblem}`);
  }
  return parsed;
}

/**
 * Count non-null karaoke_numbers per vendor key across the corpus. Keys are
 * sorted so the manifest is byte-stable across runs on identical input.
 *
 * @param {Array<{ karaoke_numbers?: Record<string, string|null> }>} records
 * @returns {Record<string, number>}
 */
export function computeVendorCounts(records) {
  const counts = new Map();
  for (const record of records) {
    for (const [vendor, number] of Object.entries(record.karaoke_numbers ?? {})) {
      if (!counts.has(vendor)) {
        counts.set(vendor, 0);
      }
      if (number !== null && number !== undefined) {
        counts.set(vendor, counts.get(vendor) + 1);
      }
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function gitHead() {
  return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Schema-validate every record; mirrors validate-songs-json.mjs (first-5
 * samples + message-prefix category summary).
 *
 * @returns {boolean} true when every record validates
 */
function validateRecords(records, validate, log) {
  let invalid = 0;
  const failureCategories = new Map();
  for (const record of records) {
    try {
      validate(record);
    } catch (err) {
      invalid += 1;
      if (invalid <= 5) {
        log.error(JSON.stringify({ id: record?.id, error: err.message }));
      }
      const key = err.message.slice(0, 80);
      failureCategories.set(key, (failureCategories.get(key) ?? 0) + 1);
    }
  }
  if (invalid === 0) {
    return true;
  }
  log.error(`Validation failures: ${invalid} / ${records.length}`);
  const sorted = [...failureCategories.entries()].sort((a, b) => b[1] - a[1]);
  log.error(
    `\nFailure summary (${invalid} invalid records, ${sorted.length} distinct error categories):`,
  );
  const countWidth = String(sorted[0]?.[1] ?? 0).length;
  for (const [msg, count] of sorted) {
    log.error(`  ${String(count).padStart(countWidth)} × ${msg}`);
  }
  return false;
}

/**
 * @param {object} opts
 * @param {string} opts.inputPath
 * @param {string} opts.url
 * @param {string} [opts.manifestOut]
 * @param {string|null} [opts.baselineCommit] - default: git rev-parse HEAD
 * @param {string|null} [opts.decisionLogPath]
 * @param {string|null} [opts.sqliteOut]
 * @param {string[]} [opts.searchHintPaths] - search-only hint sidecars, materialized into hint tokens
 * @param {{ log: Function, error: Function }} [opts.log]
 * @param {Function} [opts.validate] - injectable for tests; default loadValidator()
 * @param {Function} [opts.buildSqlite] - injectable for tests; default worker build-sqlite-db.mjs
 * @returns {Promise<number>} exit code
 */
export async function runPublishFullCorpus(opts) {
  const log = opts.log ?? console;
  const manifestOut = opts.manifestOut ?? DEFAULT_MANIFEST_PATH;

  // parseArgs already rejects malformed urls on the CLI path; this guard
  // covers programmatic callers with the same cheap fail-fast semantics.
  const urlProblem = assetUrlProblem(opts.url);
  if (urlProblem !== null) {
    log.error(`url ${urlProblem}`);
    return 2;
  }
  if (!existsSync(opts.inputPath)) {
    log.error(`input corpus not found: ${opts.inputPath}`);
    return 2;
  }
  let records;
  try {
    records = loadCorpus(opts.inputPath);
  } catch (err) {
    log.error(`cannot parse input corpus: ${err.message}`);
    return 2;
  }
  if (!Array.isArray(records) || records.length === 0) {
    log.error('input corpus must be a non-empty JSON array of records');
    return 2;
  }
  if (opts.decisionLogPath && !existsSync(opts.decisionLogPath)) {
    log.error(`decision log not found: ${opts.decisionLogPath}`);
    return 2;
  }

  const validate = opts.validate ?? (await loadValidator());
  if (!validateRecords(records, validate, log)) {
    return 1;
  }

  const { sha256, sizeBytes } = await hashFile(opts.inputPath);
  const vendorCounts = computeVendorCounts(records);
  let baselineCommit = opts.baselineCommit ?? null;
  if (baselineCommit === null) {
    try {
      baselineCommit = gitHead();
    } catch (err) {
      log.error(`cannot determine the baseline commit (pass --baseline-commit): ${err.message}`);
      return 2;
    }
  }

  const manifest = {
    version: MANIFEST_VERSION,
    url: opts.url,
    sha256,
    sizeBytes,
    recordCount: records.length,
    vendorCounts,
    generatedAt: new Date().toISOString(),
    baselineCommit,
  };
  if (opts.decisionLogPath) {
    manifest.decisionLogSha = (await hashFile(opts.decisionLogPath)).sha256;
  }

  try {
    writeManifestAtomic(manifestOut, manifest);
  } catch (err) {
    log.error(`manifest write failed: ${err.message}`);
    return 1;
  }

  if (opts.sqliteOut) {
    try {
      const buildSqlite =
        opts.buildSqlite ?? (await import(pathToFileURL(BUILD_SQLITE_PATH).href)).buildSqliteDb;
      const result = await buildSqlite({
        inputPath: opts.inputPath,
        outputPath: opts.sqliteOut,
        searchHintPaths: opts.searchHintPaths ?? [],
      });
      log.log(`SQLite DB:    ${opts.sqliteOut} (${result.bytes} bytes)`);
    } catch (err) {
      log.error(`SQLite build failed: ${err.message}`);
      return 1;
    }
  }

  log.log(`Manifest:     ${manifestOut}`);
  log.log(`Corpus:       ${opts.inputPath}`);
  log.log(`Records:      ${records.length} (all schema-valid)`);
  log.log(`Size:         ${sizeBytes} bytes`);
  log.log(`sha256:       ${sha256}`);
  log.log(
    `Vendors:      ${Object.entries(vendorCounts)
      .map(([vendor, count]) => `${vendor}=${count}`)
      .join(' ')}`,
  );
  log.log(`Baseline:     ${baselineCommit}`);
  if (manifest.decisionLogSha) {
    log.log(`Decision log: ${opts.decisionLogPath} (sha256 ${manifest.decisionLogSha})`);
  }
  if (opts.url === PENDING_URL) {
    log.log(`NOTE: url is ${PENDING_URL} (dry-run manifest) — fetch will refuse it.`);
  }
  return 0;
}

if (isCliInvocation(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(`\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  process.exit(await runPublishFullCorpus(args));
}
