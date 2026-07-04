#!/usr/bin/env node
/**
 * Build the JOYSOUND artistId index (Roadmap R4-4) from a retained detail-sweep
 * decision log.
 *
 * Why this exists
 * ---------------
 * JOYSOUND assigns a STABLE `artistId`, so it can cross-check whether two
 * artist surfaces are the same artist. The canonical corpus
 * (`full-corpus.json`) discards artistId — but the JOYSOUND detail sweep logged
 * it (inside each line's `detail` object, alongside `selSongNo`/`artistName`).
 * This script distils those logs, streamed line-by-line (the log is ~150 MB),
 * into a small index the R1 audit consumes via `--artist-id-index` as a tier-B
 * disambiguation signal (see that script's header for what the signal does and,
 * as importantly, does not, resolve):
 *
 *   joysoundNumberToArtistId  { dashless selSongNo -> artistId }
 *       keyed by the same number the corpus stores in
 *       `karaoke_numbers.joysound` (see the crawler normalizer), so the audit
 *       can look up a candidate by its joysound# — robust to a merged record
 *       whose id was won by a higher-priority source.
 *   artistNameToArtistIds     { normalizeForMatch(component) -> artistId[] }
 *       every `splitArtistCollab` component of each logged `artistName`, so an
 *       affected song's artist surface resolves to the artistId(s) JOYSOUND
 *       ever credited it under. Uses the CANONICAL clustering primitives (from
 *       the crawler dist) so the keys align exactly with the audit's
 *       `artistKeySet`.
 *
 * The generated index is a local build artifact (gitignored, like the audit
 * output) — the source log lives on the NAS, not in the repo, so CI never
 * needs it.
 *
 * Usage
 * -----
 *   node scripts/build-joysound-artist-id-index.mjs <detail-log.jsonl> [--out <file>]
 */

import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CLUSTERING_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
// Default output: gitignored (see .gitignore) so a bare invocation never stages
// the generated index.
const DEFAULT_OUT = resolve(REPO_ROOT, 'scripts/data/joysound-artist-id-index.json');

export const USAGE =
  'usage: node scripts/build-joysound-artist-id-index.mjs <detail-log.jsonl> [--out <file>]';

/** Parse CLI args. Throws on unknown flags, missing values, or missing log. */
export function parseArgs(argv) {
  const parsed = { logPath: null, outPath: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a file value');
      parsed.outPath = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (parsed.logPath === null) {
      parsed.logPath = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  if (!parsed.help && parsed.logPath === null) {
    throw new Error('a detail-log JSONL path is required');
  }
  return parsed;
}

/**
 * Canonicalize a JOYSOUND catalog number to the corpus form: strip hyphens
 * (`190-001` -> `190001`), matching the crawler's `normalizeJoysoundNumber`.
 * Returns null for a non-digits value so a malformed number is skipped rather
 * than poisoning the index.
 */
export function normalizeJoysoundNumber(raw) {
  const dashless = String(raw ?? '').replace(/-/g, '');
  return /^[0-9]+$/.test(dashless) ? dashless : null;
}

/** A fresh, empty accumulator for {@link foldRecord}. */
export function createAccumulator() {
  return {
    joysoundNumberToArtistId: new Map(),
    artistNameToArtistIds: new Map(),
    recordsWithArtistId: 0,
    numberConflicts: 0,
  };
}

/**
 * Fold one parsed decision-log record into `acc`. A record contributes only
 * when its `detail` object carries a non-empty `artistId` (the whole point of
 * the index). The joysound number map is FIRST-SEEN-WINS; a later line mapping
 * the same number to a different artistId (should never happen — one number is
 * one song) is counted in `numberConflicts` and ignored. Pure aside from
 * mutating `acc`; `deps` are the canonical clustering primitives.
 */
export function foldRecord(acc, record, deps) {
  const detail = record?.detail;
  if (detail === null || typeof detail !== 'object') return;

  const rawArtistId = detail.artistId;
  const artistId =
    typeof rawArtistId === 'string'
      ? rawArtistId.trim()
      : typeof rawArtistId === 'number'
        ? String(rawArtistId)
        : '';
  if (artistId === '') return;
  acc.recordsWithArtistId += 1;

  // number -> artistId (first-seen wins).
  const num = normalizeJoysoundNumber(detail.selSongNo ?? record.selSongNo);
  if (num !== null) {
    const existing = acc.joysoundNumberToArtistId.get(num);
    if (existing === undefined) acc.joysoundNumberToArtistId.set(num, artistId);
    else if (existing !== artistId) acc.numberConflicts += 1;
  }

  // artistName components -> artistId (splitArtistCollab + normalizeForMatch so
  // keys match the audit's artistKeySet).
  const name = typeof detail.artistName === 'string' ? detail.artistName : (record.artist ?? '');
  for (const component of deps.splitArtistCollab(String(name))) {
    const key = deps.normalizeForMatch(component);
    if (key === '') continue;
    let ids = acc.artistNameToArtistIds.get(key);
    if (ids === undefined) {
      ids = new Set();
      acc.artistNameToArtistIds.set(key, ids);
    }
    ids.add(artistId);
  }
}

/**
 * Serialize an accumulator to the on-disk index shape, with sorted keys and
 * sorted id arrays so the output is byte-stable across runs (clean diffs).
 */
export function serializeIndex(acc, meta) {
  const joysoundNumberToArtistId = {};
  for (const key of [...acc.joysoundNumberToArtistId.keys()].sort()) {
    joysoundNumberToArtistId[key] = acc.joysoundNumberToArtistId.get(key);
  }
  const artistNameToArtistIds = {};
  for (const key of [...acc.artistNameToArtistIds.keys()].sort()) {
    artistNameToArtistIds[key] = [...acc.artistNameToArtistIds.get(key)].sort();
  }
  return { _meta: meta, joysoundNumberToArtistId, artistNameToArtistIds };
}

/**
 * Load the canonical clustering primitives from the built crawler dist. Hard
 * error (with the build hint) when the dist is missing — never auto-rebuild.
 */
export async function loadClusteringDeps() {
  if (!existsSync(CLUSTERING_DIST)) {
    throw new Error(
      `missing crawler dist at ${CLUSTERING_DIST}\n  Run \`corepack pnpm --filter @karaoke/crawler build\` first.`,
    );
  }
  const { normalizeForMatch, splitArtistCollab } = await import(
    pathToFileURL(CLUSTERING_DIST).href
  );
  return { normalizeForMatch, splitArtistCollab };
}

/**
 * Stream the decision-log JSONL and write the index. `deps` is a test seam
 * (defaults to the real clustering dist import). Returns 0 on success, 2 on a
 * missing prerequisite (log or dist).
 */
export async function buildIndex({ logPath, outPath, deps = null, log = console }) {
  const resolvedLog = resolve(logPath);
  if (!existsSync(resolvedLog)) {
    log.error(`ERROR: missing detail log at ${resolvedLog}`);
    return 2;
  }
  let clusteringDeps = deps;
  if (clusteringDeps === null) {
    try {
      clusteringDeps = await loadClusteringDeps();
    } catch (err) {
      log.error(`ERROR: ${err.message}`);
      return 2;
    }
  }

  const acc = createAccumulator();
  let lines = 0;
  let parseErrors = 0;
  const rl = createInterface({
    input: createReadStream(resolvedLog, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === '') continue;
    lines += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    foldRecord(acc, record, clusteringDeps);
  }

  const resolvedOut = resolve(outPath ?? DEFAULT_OUT);
  const meta = {
    source: resolvedLog,
    generatedAt: new Date().toISOString(),
    lines,
    parseErrors,
    recordsWithArtistId: acc.recordsWithArtistId,
    joysoundNumbers: acc.joysoundNumberToArtistId.size,
    artistNameKeys: acc.artistNameToArtistIds.size,
    numberConflicts: acc.numberConflicts,
  };
  writeJsonAtomic(resolvedOut, serializeIndex(acc, meta));

  log.log(
    `lines: ${lines}  parse errors: ${parseErrors}  with artistId: ${acc.recordsWithArtistId}`,
  );
  log.log(
    `joysound numbers: ${meta.joysoundNumbers}  artist keys: ${meta.artistNameKeys}  number conflicts: ${meta.numberConflicts}`,
  );
  log.log(`wrote ${resolvedOut}`);
  return 0;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  process.exitCode = await buildIndex({ logPath: args.logPath, outPath: args.outPath });
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(`build-joysound-artist-id-index failed: ${err.message}`);
    process.exitCode = 1;
  });
}
