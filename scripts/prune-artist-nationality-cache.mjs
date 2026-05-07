/**
 * Prune stale entries from tj-search-cache.json's artistNationalityMap.
 *
 * Background: the bootstrap sweep (bootstrapCharts.ts) samples TJ's JPOP and
 * KPOP charts over a rolling 2-year window. Every artist that charted — even
 * Korean acts that `classifyRecord` immediately rejects via the drop list —
 * gets a key written into artistNationalityMap. After iterative corpus
 * refinement (drop-list growth, Chinese/Korean denylist expansion), ~96% of
 * those keys no longer correspond to any artist_primary in the live corpus.
 * They are unreachable: no classifyRecord call will ever look them up again.
 *
 * This script filters artistNationalityMap to only the keys reachable from the
 * current corpus, recovering ~2-3 MB of cache file size without affecting any
 * classification result.
 *
 * Reachable key definition (conservative — mirrors the write paths exactly):
 *   For each corpus record's artist_primary, generate:
 *     - normalizeForMatch(artist_primary)          (whole-string key)
 *     - normalizeForMatch(component) for each component
 *       from splitArtistCollab(artist_primary)    (per-component keys)
 *
 *   This matches both write paths:
 *     - bootstrapCharts.ts writes normalizeForMatch(item.indexSong) where
 *       indexSong is a raw TJ artist string (= whole-string key).
 *     - enrichArtistMap.ts writes normalizeForMatch(component) for each
 *       splitArtistCollab component (= per-component keys).
 *   And the read path in parser.ts classifyRecord, which looks up the lead
 *   component key.
 *
 * Safety: missing keys in artistNationalityMap are handled gracefully by the
 * parser (lookup returns undefined → falls through to next admit path). Pruning
 * an unreachable key has zero effect on classification.
 *
 * Idempotent: a second run on an already-pruned cache drops zero additional
 * keys (the reachable set is deterministic from the corpus).
 *
 * Atomic write: .tmp + renameSync, matching the pattern in other .mjs scripts.
 *
 * Usage:
 *   node scripts/prune-artist-nationality-cache.mjs
 */

import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SONGS_PATH = resolve(REPO_ROOT, 'apps/web/public/data/songs.json');
const CACHE_PATH = resolve(REPO_ROOT, 'apps/web/public/data/tj-search-cache.json');

// ---------------------------------------------------------------------------
// Inline normalizeForMatch — matches clustering.ts exactly.
// Rule: strip whitespace + lowercase + NFKC.
// Changing this rule invalidates on-disk caches; keep in sync with
// packages/crawler/src/clustering.ts normalizeForMatch.
// ---------------------------------------------------------------------------

/** @param {string} s */
function normalizeForMatch(s) {
  return s.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
}

// ---------------------------------------------------------------------------
// Inline splitArtistCollab — matches clustering.ts exactly.
// Returns whole string as element 0, then individual components.
// Keep the delimiter set in sync with SPLIT_RE in clustering.ts.
// ---------------------------------------------------------------------------

const FEAT_PAREN_RE = /\s*\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)\s*/gi;
const SPLIT_RE = /\s*[&＆,×｜]\s*|\s+with\s+|\s+meets\s+|\s*feat\.\s*/i;
const OF_RE = /\s+of\s+/i;

/** @param {string} artist @returns {string[]} */
function splitArtistCollab(artist) {
  const whole = artist.trim();
  if (whole === '') return [];

  const parts = [whole];

  const featContents = [];
  // Reset lastIndex before each use — FEAT_PAREN_RE has /g flag.
  FEAT_PAREN_RE.lastIndex = 0;
  let main = whole.replace(FEAT_PAREN_RE, (_, inner) => {
    featContents.push(inner);
    return ' ';
  });
  main = main.trim();

  if (main !== '') {
    for (const piece of main.split(SPLIT_RE)) {
      const trimmed = piece.trim();
      if (trimmed !== '') parts.push(trimmed);
    }
  }

  for (const fc of featContents) {
    if (fc !== '') parts.push(fc);
    if (fc !== '' && OF_RE.test(fc)) {
      for (const piece of fc.split(OF_RE)) {
        const trimmed = piece.trim();
        if (trimmed !== '') parts.push(trimmed);
      }
    }
  }

  // Dedupe by normalizeForMatch, preserving first-seen order.
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = normalizeForMatch(part);
    if (key === '') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const sizeBefore = statSync(CACHE_PATH).size;

const songs = JSON.parse(readFileSync(SONGS_PATH, 'utf8'));
const cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));

if (
  typeof cache !== 'object' ||
  cache === null ||
  typeof cache.artistNationalityMap !== 'object'
) {
  console.error('Unexpected cache shape — aborting');
  process.exit(1);
}

// Build reachable key set from all corpus artist_primary values.
// Keys are produced by normalizeForMatch (whole string) + splitArtistCollab
// component normalization — exactly what enrichArtistMap.ts and
// bootstrapCharts.ts write and what parser.ts classifyRecord reads.
const reachable = new Set();

for (const record of songs) {
  const artist = typeof record.artist_primary === 'string' ? record.artist_primary : '';
  if (artist === '') continue;

  // Whole-string key (written by bootstrapCharts chart-sweep path).
  reachable.add(normalizeForMatch(artist));

  // Per-component keys (written by enrichArtistMap per-component scan path).
  for (const component of splitArtistCollab(artist)) {
    reachable.add(normalizeForMatch(component));
  }
}

const originalMap = cache.artistNationalityMap;
const totalIn = Object.keys(originalMap).length;

const prunedMap = {};
for (const [key, value] of Object.entries(originalMap)) {
  if (reachable.has(key)) {
    prunedMap[key] = value;
  }
}

const totalKept = Object.keys(prunedMap).length;
const totalDropped = totalIn - totalKept;

// Preserve all top-level fields exactly. The cache loader's `extras` bag
// round-trips any unrecognized fields — we preserve everything here too.
const out = { ...cache, artistNationalityMap: prunedMap };

const tmp = `${CACHE_PATH}.tmp`;
writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
renameSync(tmp, CACHE_PATH);

const sizeAfter = statSync(CACHE_PATH).size;

console.log(`prune-artist-nationality-cache:`);
console.log(`  total_in:          ${totalIn}`);
console.log(`  total_kept:        ${totalKept}`);
console.log(`  total_dropped:     ${totalDropped}`);
console.log(`  size_before_bytes: ${sizeBefore}`);
console.log(`  size_after_bytes:  ${sizeAfter}`);
console.log(`  size_delta_bytes:  ${sizeBefore - sizeAfter} (recovered)`);
console.log(`  size_before_mb:    ${(sizeBefore / 1024 / 1024).toFixed(2)} MB`);
console.log(`  size_after_mb:     ${(sizeAfter / 1024 / 1024).toFixed(2)} MB`);
