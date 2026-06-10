#!/usr/bin/env node
/**
 * verify-manifest.mjs — cheap CI shape gate for the tracked full-corpus
 * manifest (PR-2 of the post-JOYSOUND data topology — see
 * docs/ARCHITECTURE.md "Full-corpus distribution").
 *
 * Validates `data/full-corpus.manifest.json` against the version-1 shape via
 * the same `scripts/lib/manifest.mjs` validator the publisher and fetcher
 * use. NEVER downloads the corpus asset — this runs on every PR, and the
 * full sha256 recompute against the real asset happens once, in
 * `full-corpus.yml` at publish time.
 *
 * A `PENDING` url is rejected by default: PENDING marks a local dry-run
 * manifest (publish-full-corpus.mjs before the release asset exists), and a
 * tracked manifest must always describe a published asset. Pass
 * `--allow-pending` to check a dry-run manifest locally.
 */

import { isCliInvocation } from './lib/cli.mjs';
import { DEFAULT_MANIFEST_PATH, PENDING_URL, readManifest } from './lib/manifest.mjs';

export const USAGE = [
  'usage: node scripts/verify-manifest.mjs [options]',
  '',
  'Shape-validates the tracked full-corpus manifest (no download).',
  '',
  'options:',
  '  --manifest <path>   manifest to verify (default: data/full-corpus.manifest.json)',
  `  --allow-pending     accept a ${PENDING_URL} url (local dry-run manifests only)`,
  '  --help              show this message',
  '',
  'exit codes: 0 ok · 1 missing/invalid manifest · 2 bad arguments',
].join('\n');

/**
 * @param {string[]} argv
 * @returns {{ manifestPath: string, allowPending: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const parsed = {
    manifestPath: DEFAULT_MANIFEST_PATH,
    allowPending: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--allow-pending') {
      parsed.allowPending = true;
      continue;
    }
    if (arg === '--manifest') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--manifest requires a value');
      }
      parsed.manifestPath = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

/**
 * @param {object} opts
 * @param {string} [opts.manifestPath]
 * @param {boolean} [opts.allowPending]
 * @param {{ log: Function, error: Function }} [opts.log]
 * @returns {number} exit code
 */
export function runVerifyManifest(opts = {}) {
  const log = opts.log ?? console;
  const manifestPath = opts.manifestPath ?? DEFAULT_MANIFEST_PATH;

  let manifest;
  try {
    manifest = readManifest(manifestPath);
  } catch (err) {
    log.error(err.message);
    return 1;
  }

  if (manifest.url === PENDING_URL && !opts.allowPending) {
    log.error(
      `manifest url is ${PENDING_URL} (dry-run manifest) — a tracked manifest must point at a published asset. Publish the release and run full-corpus.yml to regenerate it, or pass --allow-pending for a local dry-run check.`,
    );
    return 1;
  }

  log.log(`manifest OK: ${manifestPath}`);
  log.log(`  url:     ${manifest.url}`);
  log.log(`  records: ${manifest.recordCount}`);
  log.log(`  size:    ${manifest.sizeBytes} bytes`);
  log.log(`  sha256:  ${manifest.sha256}`);
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
  process.exit(runVerifyManifest(args));
}
