#!/usr/bin/env node
/**
 * fetch-full-corpus.mjs — download the full corpus described by the tracked
 * manifest and verify it before it ever reaches its destination path (PR-1
 * of the post-JOYSOUND data topology — see docs/OPEN-QUESTIONS.md item 1).
 *
 * Shared consumer for local dev, the self-host SQLite build, and the D1
 * import: each of them takes the verified JSON this script produces.
 *
 * Integrity contract: the download streams to a run-unique
 * `<out>.<pid>.<uuid>.tmp` (concurrent fetches can never tear each other);
 * sha256 and sizeBytes are verified against the manifest BEFORE the atomic
 * rename, and a mismatch deletes the tmp file — an 85 MB download can never
 * leave a torn or corrupt file at --out. http(s) downloads abort after
 * --timeout-ms (default 10 min) so a stalled transfer cannot hang forever.
 * Plain `file://` URLs are supported so local testing and future store
 * swaps need no HTTP server.
 */

import { randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { DEFAULT_MANIFEST_PATH, PENDING_URL, hashFile, readManifest } from './lib/manifest.mjs';

/** Generous default for an ~85 MB release asset on a slow link. */
export const DEFAULT_TIMEOUT_MS = 600_000;

export const USAGE = [
  'usage: node scripts/fetch-full-corpus.mjs --out <corpus.json> [options]',
  '',
  'Downloads the corpus described by the manifest, verifying sha256 + size',
  'before the atomic rename into place (no torn files on failure).',
  '',
  'options:',
  '  --manifest <path>          manifest to read (default: data/full-corpus.manifest.json)',
  '  --out <path>               destination corpus path (required)',
  '  --skip-download-if-valid   no-op when --out already matches the manifest sha256',
  '  --timeout-ms <n>           abort a stalled http(s) download after n ms (default: 600000)',
  '  --help                     show this message',
  '',
  'exit codes: 0 ok · 1 download/verification failure · 2 bad arguments or bad manifest',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {{ manifestPath: string, outPath: string|null, skipIfValid: boolean,
 *             timeoutMs: number, help: boolean }}
 */
export function parseArgs(argv) {
  const parsed = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    outPath: null,
    skipIfValid: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  const valueFlags = new Map([
    ['--manifest', 'manifestPath'],
    ['--out', 'outPath'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--skip-download-if-valid') {
      parsed.skipIfValid = true;
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
  if (parsed.timeoutMs !== DEFAULT_TIMEOUT_MS) {
    const timeoutMs = Number(parsed.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`--timeout-ms must be a positive integer (got ${parsed.timeoutMs})`);
    }
    parsed.timeoutMs = timeoutMs;
  }
  if (!parsed.help && parsed.outPath === null) {
    throw new Error('--out <corpus.json> is required');
  }
  return parsed;
}

/**
 * Stream `url` (http(s) or file://) into `destPath`. The timeout covers the
 * whole http(s) transfer (headers AND body) so a stalled release download
 * cannot hang forever; local file:// copies are not subject to it.
 */
async function download(url, destPath, timeoutMs) {
  if (url.startsWith('file://')) {
    await pipeline(createReadStream(fileURLToPath(url)), createWriteStream(destPath));
    return;
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  if (response.body === null) {
    throw new Error(`empty response body for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath), { signal });
}

/**
 * @param {object} opts
 * @param {string} [opts.manifestPath]
 * @param {string} opts.outPath
 * @param {boolean} [opts.skipIfValid]
 * @param {number} [opts.timeoutMs]
 * @param {{ log: Function, error: Function }} [opts.log]
 * @returns {Promise<number>} exit code
 */
export async function runFetchFullCorpus(opts) {
  const log = opts.log ?? console;
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (err) {
    log.error(err.message);
    return 2;
  }

  if (manifest.url === PENDING_URL) {
    log.error(
      `manifest url is ${PENDING_URL} (dry-run manifest, no published asset yet). Publish the release asset and re-run publish-full-corpus.mjs with the real --url first.`,
    );
    return 2;
  }

  if (opts.skipIfValid && existsSync(opts.outPath)) {
    const existing = await hashFile(opts.outPath);
    if (existing.sha256 === manifest.sha256 && existing.sizeBytes === manifest.sizeBytes) {
      log.log(`already valid: ${opts.outPath} matches manifest sha256 — skipping download`);
      return 0;
    }
    log.log(`${opts.outPath} exists but does not match the manifest — re-downloading`);
  }

  // Unique tmp name (pid + uuid): concurrent fetches of the same --out can
  // never write into (or truncate) each other's in-flight file between the
  // verify and the rename; each failure path cleans up only its OWN tmp.
  const tmpPath = `${opts.outPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(opts.outPath), { recursive: true });
    log.log(`downloading ${manifest.url} (${manifest.sizeBytes} bytes expected)`);
    await download(manifest.url, tmpPath, timeoutMs);

    const actual = await hashFile(tmpPath);
    if (actual.sha256 !== manifest.sha256 || actual.sizeBytes !== manifest.sizeBytes) {
      log.error('downloaded file does not match the manifest — deleting it:');
      log.error(`  sha256 expected ${manifest.sha256}`);
      log.error(`  sha256 actual   ${actual.sha256}`);
      log.error(`  size expected   ${manifest.sizeBytes}`);
      log.error(`  size actual     ${actual.sizeBytes}`);
      rmSync(tmpPath, { force: true });
      return 1;
    }
    renameSync(tmpPath, opts.outPath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    log.error(`download failed: ${err.message}`);
    return 1;
  }

  log.log(`Corpus:  ${opts.outPath}`);
  log.log(`Records: ${manifest.recordCount}`);
  log.log(`Size:    ${manifest.sizeBytes} bytes (verified)`);
  log.log(`sha256:  ${manifest.sha256} (verified)`);
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
  process.exit(await runFetchFullCorpus(args));
}
