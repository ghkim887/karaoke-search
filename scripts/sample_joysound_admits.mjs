#!/usr/bin/env node
/**
 * Layer-3 sampling verification for the JOYSOUND deploy-readiness gate.
 *
 * Spec §5 Layer-3 has two checks:
 *   - Sampling confidence: a random sample of ADMITTED rows is >=99% JP-origin.
 *   - Recall sanity (over-drop check): known-Japanese songs that SHOULD be
 *     admitted are present; estimate over-drop.
 *
 * This is analysis-only tooling. It reads the sweep's decision log + the
 * existing corpus and emits:
 *   1. Four 100-row admit label-chunks for human/agent labeling.
 *   2. A recall-overlap report (existing blog-sourced joysound numbers that the
 *      sweep also admits) + a list of non-admitted known numbers (over-drops to
 *      eyeball).
 *   3. A 60-row drop sample (precision-first buckets: drop-han-only +
 *      drop-ascii-only) for an over-drop spot-check.
 *   4. A layer3-stats.json summary.
 *
 * Determinism: rows are ordered by a seeded FNV-1a hash of `selSongNo`, with a
 * `selSongNo` lexical tie-break. The ordering is independent of the input file
 * order and byte-stable across runs (no Math.random, no Date). All writes are
 * atomic via the shared helper.
 *
 * Usage:
 *   node scripts/sample_joysound_admits.mjs
 *
 * Optional overrides (positional, rarely needed):
 *   node scripts/sample_joysound_admits.mjs <decision-log.jsonl> <songs.json> <out-dir>
 */

import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const SWEEP_DIR = resolve(REPO_ROOT, '.tmp_review/joysound-sweep-2026-06-09');
const DEFAULT_DECISION_LOG = resolve(SWEEP_DIR, 'postfix/decision-log.jsonl');
const DEFAULT_CORPUS = resolve(REPO_ROOT, 'apps/web/public/data/songs.json');
const DEFAULT_OUT_DIR = resolve(SWEEP_DIR, 'layer3');

// Fixed seed makes the pseudo-random ordering reproducible.
const SEED = 'joysound-layer3-2026-06-09';

const ADMIT_SAMPLE_TOTAL = 400;
const ADMIT_CHUNK_SIZE = 100;
const ADMIT_CHUNK_COUNT = ADMIT_SAMPLE_TOTAL / ADMIT_CHUNK_SIZE;
const DROP_SAMPLE_TOTAL = 60;
// Precision-first drop buckets we want a human to eyeball for over-drop.
const DROP_SAMPLE_REASONS = new Set(['drop-han-only', 'drop-ascii-only']);

/**
 * Normalize a karaoke number to digits-only with no leading zeros. Both the
 * decision-log selSongNo and the corpus joysound values are already dashless
 * plain digits, but this stays defensive so the recall join is robust to
 * future format drift.
 * @param {unknown} raw
 * @returns {string | null}
 */
function normalizeNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  const trimmed = digits.replace(/^0+/, '');
  return trimmed.length === 0 ? '0' : trimmed;
}

/**
 * Deterministic 32-bit FNV-1a hash of `${SEED}:${key}`, returned as an 8-char
 * lowercase hex string so it sorts lexically the same as numerically.
 * @param {string} key
 * @returns {string}
 */
function seededHashHex(key) {
  let hash = 0x811c9dc5;
  const input = `${SEED}:${key}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiply, kept in 32-bit unsigned range via Math.imul.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable deterministic sort key for a row: seeded hash first, selSongNo as
 * tie-break. Collisions on the hash are broken lexically so the order never
 * depends on input position.
 * @param {{ selSongNo: string }} row
 * @returns {string}
 */
function sortKeyFor(row) {
  return `${seededHashHex(row.selSongNo)}|${row.selSongNo}`;
}

/**
 * Read the decision log into admit/drop arrays plus tallies.
 * @param {string} path
 */
async function readDecisionLog(path) {
  const admits = [];
  const drops = [];
  /** @type {Record<string, number>} */
  const byDecision = {};
  /** @type {Record<string, number>} */
  const admitReasonCounts = {};
  /** @type {Record<string, number>} */
  const dropReasonCounts = {};
  // selSongNo -> reason, admits only, for the recall join.
  const admitNumbers = new Map();

  // selSongNo -> reason, drops only, for the over-drop classification of
  // non-admitted known numbers (was the known number actively DROPPED, or just
  // ABSENT from the listing entirely?).
  const dropNumbers = new Map();

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    byDecision[row.decision] = (byDecision[row.decision] ?? 0) + 1;
    if (row.decision === 'admit') {
      admitReasonCounts[row.reason] = (admitReasonCounts[row.reason] ?? 0) + 1;
      admits.push(row);
      const norm = normalizeNumber(row.selSongNo);
      if (norm !== null && !admitNumbers.has(norm)) admitNumbers.set(norm, row.reason);
    } else if (row.decision === 'drop') {
      dropReasonCounts[row.reason] = (dropReasonCounts[row.reason] ?? 0) + 1;
      drops.push(row);
      const norm = normalizeNumber(row.selSongNo);
      if (norm !== null && !dropNumbers.has(norm)) dropNumbers.set(norm, row.reason);
    }
  }

  return {
    admits,
    drops,
    byDecision,
    admitReasonCounts,
    dropReasonCounts,
    admitNumbers,
    dropNumbers,
  };
}

/**
 * Deterministically take the first `count` rows by seeded sort key.
 * @template {{ selSongNo: string }} T
 * @param {T[]} rows
 * @param {number} count
 * @returns {T[]}
 */
function deterministicSample(rows, count) {
  return [...rows]
    .sort((a, b) => {
      const ka = sortKeyFor(a);
      const kb = sortKeyFor(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .slice(0, count);
}

/**
 * Project a decision-log row to the minimal labeling shape.
 * @param {{ selSongNo: string, title: string, artist: string, reason: string }} row
 */
function toLabelRow(row) {
  return {
    selSongNo: row.selSongNo,
    title: row.title,
    artist: row.artist,
    reason: row.reason,
  };
}

/**
 * Tally the reason distribution of a sampled set.
 * @param {{ reason: string }[]} rows
 * @returns {Record<string, number>}
 */
function reasonDistribution(rows) {
  /** @type {Record<string, number>} */
  const dist = {};
  for (const row of rows) dist[row.reason] = (dist[row.reason] ?? 0) + 1;
  return dist;
}

async function main() {
  const [decisionLogArg, corpusArg, outDirArg] = process.argv.slice(2);
  const decisionLogPath = decisionLogArg ? resolve(decisionLogArg) : DEFAULT_DECISION_LOG;
  const corpusPath = corpusArg ? resolve(corpusArg) : DEFAULT_CORPUS;
  const outDir = outDirArg ? resolve(outDirArg) : DEFAULT_OUT_DIR;

  // --- Read inputs ---------------------------------------------------------
  const {
    admits,
    drops,
    byDecision,
    admitReasonCounts,
    dropReasonCounts,
    admitNumbers,
    dropNumbers,
  } = await readDecisionLog(decisionLogPath);

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));

  // --- 1. Admit sample for labeling ---------------------------------------
  const admitSample = deterministicSample(admits, ADMIT_SAMPLE_TOTAL);
  const admitChunkPaths = [];
  for (let i = 0; i < ADMIT_CHUNK_COUNT; i++) {
    const chunk = admitSample
      .slice(i * ADMIT_CHUNK_SIZE, (i + 1) * ADMIT_CHUNK_SIZE)
      .map(toLabelRow);
    const nn = String(i).padStart(2, '0');
    const chunkPath = resolve(outDir, `sample-admit-chunk-${nn}-input.json`);
    writeJsonAtomic(chunkPath, chunk);
    admitChunkPaths.push(chunkPath);
  }
  const admitSampleReasonDist = reasonDistribution(admitSample);

  // --- 2. Recall sanity (over-drop proxy) ---------------------------------
  // Existing blog-sourced joysound numbers in the live corpus. How many does
  // the sweep also admit? Non-admitted ones are candidate over-drops.
  const corpusJoyNumbers = new Set();
  for (const record of corpus) {
    const joy = record?.karaoke_numbers?.joysound;
    const norm = normalizeNumber(joy);
    if (norm !== null) corpusJoyNumbers.add(norm);
  }

  let recallOverlap = 0;
  const notAdmitted = [];
  // Split the non-admitted known numbers into two very different cohorts:
  //   - droppedKnown: the sweep SAW the number and dropped it. These are the
  //     true over-drop candidates (a known-catalogued JP song the precision
  //     filter rejected).
  //   - absentKnown: the number is not in the sweep listing at all — a stale or
  //     delisted blog-sourced number, NOT a sweep precision failure. These
  //     should not count against over-drop.
  const droppedKnown = [];
  const absentKnown = [];
  /** @type {Record<string, number>} */
  const droppedKnownReasonCounts = {};
  for (const norm of corpusJoyNumbers) {
    if (admitNumbers.has(norm)) {
      recallOverlap++;
      continue;
    }
    notAdmitted.push(norm);
    const dropReason = dropNumbers.get(norm);
    if (dropReason !== undefined) {
      droppedKnown.push({ selSongNo: norm, reason: dropReason });
      droppedKnownReasonCounts[dropReason] = (droppedKnownReasonCounts[dropReason] ?? 0) + 1;
    } else {
      absentKnown.push(norm);
    }
  }
  notAdmitted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  absentKnown.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  droppedKnown.sort((a, b) => (a.selSongNo < b.selSongNo ? -1 : a.selSongNo > b.selSongNo ? 1 : 0));
  const recallTotal = corpusJoyNumbers.size;
  const recallPct = recallTotal === 0 ? 0 : (recallOverlap / recallTotal) * 100;
  // Listing-scoped recall: of the known numbers the sweep actually SAW
  // (admitted + dropped), what fraction did it admit? This is the honest
  // over-drop denominator (excludes delisted/absent numbers).
  const sawKnown = recallOverlap + droppedKnown.length;
  const recallSeenPct = sawKnown === 0 ? 0 : (recallOverlap / sawKnown) * 100;

  // --- 3. Over-drop estimate: drop-bucket sizes + spot-check sample --------
  const dropSpotCheckPool = drops.filter((row) => DROP_SAMPLE_REASONS.has(row.reason));
  const dropSample = deterministicSample(dropSpotCheckPool, DROP_SAMPLE_TOTAL).map(toLabelRow);
  const dropSamplePath = resolve(outDir, 'sample-drop-input.json');
  writeJsonAtomic(dropSamplePath, dropSample);
  const dropSampleReasonDist = reasonDistribution(dropSample);

  // --- 4. Stats summary ----------------------------------------------------
  const stats = {
    seed: SEED,
    decisionLog: decisionLogPath,
    corpus: corpusPath,
    totals: {
      decisionLogRows: (byDecision.admit ?? 0) + (byDecision.drop ?? 0),
      admit: byDecision.admit ?? 0,
      drop: byDecision.drop ?? 0,
    },
    admitReasonCounts,
    dropReasonCounts,
    admitSample: {
      size: admitSample.length,
      chunkCount: ADMIT_CHUNK_COUNT,
      chunkSize: ADMIT_CHUNK_SIZE,
      reasonDistribution: admitSampleReasonDist,
    },
    recall: {
      corpusBlogJoysoundNumbers: recallTotal,
      admittedOverlap: recallOverlap,
      overlapPct: Number(recallPct.toFixed(2)),
      notAdmittedCount: notAdmitted.length,
      // Of the non-admitted: split into actively-dropped (true over-drop
      // candidates) vs absent-from-listing (stale/delisted blog numbers).
      droppedKnownCount: droppedKnown.length,
      droppedKnownReasonCounts,
      droppedKnown,
      absentFromListingCount: absentKnown.length,
      absentFromListingNumbers: absentKnown,
      // Listing-scoped recall (honest over-drop denominator): admitted /
      // (admitted + dropped) among known numbers the sweep actually saw.
      seenKnownNumbers: sawKnown,
      recallAmongSeenPct: Number(recallSeenPct.toFixed(2)),
    },
    dropSample: {
      size: dropSample.length,
      buckets: [...DROP_SAMPLE_REASONS],
      poolSize: dropSpotCheckPool.length,
      reasonDistribution: dropSampleReasonDist,
    },
  };
  const statsPath = resolve(outDir, 'layer3-stats.json');
  writeJsonAtomic(statsPath, stats);

  // --- Console summary -----------------------------------------------------
  console.log('JOYSOUND Layer-3 sampling complete.');
  console.log(`  admit=${stats.totals.admit} drop=${stats.totals.drop}`);
  console.log(`  admit sample: ${admitSample.length} rows over ${ADMIT_CHUNK_COUNT} chunks`);
  console.log(`    reason dist: ${JSON.stringify(admitSampleReasonDist)}`);
  console.log(
    `  recall overlap: ${recallOverlap}/${recallTotal} (${stats.recall.overlapPct}%), ` +
      `${notAdmitted.length} known numbers not admitted`,
  );
  console.log(
    `    not-admitted split: ${droppedKnown.length} dropped (over-drop candidates) + ` +
      `${absentKnown.length} absent from listing`,
  );
  console.log(
    `    recall among seen: ${recallOverlap}/${sawKnown} (${stats.recall.recallAmongSeenPct}%); ` +
      `dropped-known reasons: ${JSON.stringify(droppedKnownReasonCounts)}`,
  );
  console.log(`  drop spot-check: ${dropSample.length} rows from [${[...DROP_SAMPLE_REASONS]}]`);
  console.log('  outputs:');
  for (const p of admitChunkPaths) console.log(`    ${p}`);
  console.log(`    ${dropSamplePath}`);
  console.log(`    ${statsPath}`);
}

main().catch((err) => {
  console.error('sample_joysound_admits failed:', err);
  process.exit(1);
});
