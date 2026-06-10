/**
 * Shared full-corpus manifest helpers for scripts/*.mjs.
 *
 * The full corpus (post-JOYSOUND, ~85 MB) lives OUTSIDE git as a release
 * asset; git tracks only a small manifest describing it. This module is the
 * single implementation of the manifest shape, its validation, and the
 * streaming sha256 used by both the publisher (`publish-full-corpus.mjs`)
 * and the fetcher (`fetch-full-corpus.mjs`).
 *
 * Manifest schema (version 1, store-agnostic — swapping GitHub Releases for
 * R2 later is a one-line `url` change):
 *
 *   {
 *     version: 1,
 *     url: string,            // release-asset URL, file:// URL, or 'PENDING'
 *     sha256: string,         // 64-char lowercase hex of the corpus JSON
 *     sizeBytes: number,      // exact byte size of the corpus JSON
 *     recordCount: number,    // records in the corpus array
 *     vendorCounts: object,   // non-null karaoke_numbers per vendor key
 *     generatedAt: string,    // ISO-8601 timestamp of manifest generation
 *     baselineCommit: string, // git sha the corpus was composed against
 *     decisionLogSha?: string // optional sha256 of the crawl decision log
 *   }
 *
 * Exports:
 *   MANIFEST_VERSION       — current schema version (pinned to 1)
 *   PENDING_URL            — placeholder url for dry-run manifests
 *   DEFAULT_MANIFEST_PATH  — tracked location: data/full-corpus.manifest.json
 *   assetUrlProblem(url)   — asset-url shape check shared with publish --url
 *   hashFile(path)         — streaming sha256 + byte size (no full read into memory)
 *   validateManifest(value)— shape check; throws listing every problem
 *   readManifest(path)     — load + parse + validate
 *   writeManifestAtomic(path, manifest) — validate then atomic JSON write
 */

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './atomic-write.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

export const MANIFEST_VERSION = 1;

/** Placeholder url for dry-run manifests. The fetcher refuses to consume it. */
export const PENDING_URL = 'PENDING';

/**
 * Tracked manifest location. Deliberately OUTSIDE apps/web/public/ so the
 * static deploy never bundles it, and at the repo root (not scripts/data/)
 * because it describes a repo-level data artifact, not script state.
 */
export const DEFAULT_MANIFEST_PATH = resolve(HERE, '../../data/full-corpus.manifest.json');

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const KNOWN_KEYS = new Set([
  'version',
  'url',
  'sha256',
  'sizeBytes',
  'recordCount',
  'vendorCounts',
  'generatedAt',
  'baselineCommit',
  'decisionLogSha',
]);
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/**
 * Check an asset-url value (manifest `url` field / publish `--url` flag).
 * The PENDING placeholder is acceptable (dry-run manifests).
 *
 * @param {unknown} url
 * @returns {string|null} a problem description, or null when acceptable
 */
export function assetUrlProblem(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return 'must be a non-empty string';
  }
  if (url === PENDING_URL) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `is not a valid URL: ${url}`;
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    return `protocol must be http(s) or file (got ${parsed.protocol})`;
  }
  return null;
}

/**
 * Stream a file through sha256. Never buffers the whole file — the real
 * corpus is ~85 MB and this also runs on CI runners.
 *
 * @param {string} path
 * @returns {Promise<{ sha256: string, sizeBytes: number }>}
 */
export function hashFile(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', rejectPromise);
    stream.on('end', () => {
      resolvePromise({ sha256: hash.digest('hex'), sizeBytes });
    });
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a manifest value against the version-1 shape. Collects every
 * problem before throwing so a malformed manifest is diagnosable in one pass.
 *
 * @param {unknown} value
 * @returns {object} the validated manifest (same reference)
 */
export function validateManifest(value) {
  const problems = [];
  if (!isPlainObject(value)) {
    throw new Error('manifest: expected a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) {
      problems.push(`unknown key "${key}"`);
    }
  }
  if (value.version !== MANIFEST_VERSION) {
    problems.push(`version must be ${MANIFEST_VERSION} (got ${JSON.stringify(value.version)})`);
  }
  const urlProblem = assetUrlProblem(value.url);
  if (urlProblem !== null) {
    problems.push(`url ${urlProblem}`);
  }
  if (typeof value.sha256 !== 'string' || !SHA256_HEX_RE.test(value.sha256)) {
    problems.push('sha256 must be 64 lowercase hex chars');
  }
  if (!Number.isInteger(value.sizeBytes) || value.sizeBytes <= 0) {
    problems.push('sizeBytes must be a positive integer');
  }
  if (!Number.isInteger(value.recordCount) || value.recordCount <= 0) {
    problems.push('recordCount must be a positive integer');
  }
  if (!isPlainObject(value.vendorCounts)) {
    problems.push('vendorCounts must be an object');
  } else {
    for (const [vendor, count] of Object.entries(value.vendorCounts)) {
      if (!Number.isInteger(count) || count < 0) {
        problems.push(`vendorCounts.${vendor} must be a non-negative integer`);
      }
    }
  }
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) {
    problems.push('generatedAt must be an ISO-8601 date-time string');
  }
  if (typeof value.baselineCommit !== 'string' || !GIT_SHA_RE.test(value.baselineCommit)) {
    problems.push('baselineCommit must be a 7-40 char lowercase hex git sha');
  }
  if (value.decisionLogSha !== undefined) {
    if (typeof value.decisionLogSha !== 'string' || !SHA256_HEX_RE.test(value.decisionLogSha)) {
      problems.push('decisionLogSha must be 64 lowercase hex chars when present');
    }
  }
  if (problems.length > 0) {
    throw new Error(`manifest: invalid shape:\n  - ${problems.join('\n  - ')}`);
  }
  return value;
}

/**
 * Read, parse, and validate a manifest file.
 *
 * @param {string} path
 * @returns {object} validated manifest
 */
export function readManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`manifest: cannot read ${path}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest: ${path} is not valid JSON: ${err.message}`);
  }
  return validateManifest(parsed);
}

/**
 * Validate then atomically write a manifest (indent=2, trailing newline —
 * the canonical tracked-JSON byte-shape).
 *
 * @param {string} path
 * @param {object} manifest
 */
export function writeManifestAtomic(path, manifest) {
  validateManifest(manifest);
  writeJsonAtomic(path, manifest, { indent: 2, trailingNewline: true });
}
