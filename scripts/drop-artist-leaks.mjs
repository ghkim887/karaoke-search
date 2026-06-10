#!/usr/bin/env node
/**
 * One-shot + re-runnable corpus cleanup: drop records whose artist matches
 * the Korean-artist or Chinese-artist (Cantopop / Mandopop) drop list, plus
 * — for the chinese pass — a small set of catalog-anomaly IDs.
 *
 * Replaces the former Python pair `scripts/drop_kpop_leaks.py` /
 * `scripts/drop_cpop_leaks.py`. Those scripts consumed JSON sidecars
 * (re-exports of the TS drop lists) plus a hand-mirrored Python copy of the
 * artist splitter because Python cannot import the TS source. This script
 * imports the canonical implementations straight from the built crawler dist
 * (`isInDropList` / `isInChineseDropList` / `normalizeForMatch` /
 * `splitArtistCollab`), so the corpus-level filter is EXACTLY the same
 * predicate the crawl-time parser applies in `classifyRecord` — zero parity
 * machinery for the Chinese list (the Korean sidecar stays: it still has a
 * Python consumer in `scripts/ingest_anisong_pdf.py`).
 *
 * Why this exists
 * ---------------
 * The TJ-direct adapter applies the drop lists inside its parser, so the next
 * re-crawl produces a clean corpus. Re-crawling, however, takes 2-3 hours of
 * TJ-search calls. This script re-applies the same drop set against an
 * already-crawled `apps/web/public/data/songs.json` so a maintainer who adds
 * new entries to a drop list can clean the corpus without paying the re-crawl
 * cost. It applies against ALL records regardless of `id` source prefix
 * (`tj-`, `blog-`, `tjpdf-`) — the corpus-level filter is the canonical one;
 * the parser filter is a crawl-time efficiency win.
 *
 * Catalog-anomaly IDs (chinese pass only)
 * ---------------------------------------
 * A small hardcoded list of TJ IDs whose `artist_primary` is malformed in the
 * TJ source (e.g. literal `-` for tj-72638, a record whose simplified-Chinese
 * title `明天你是否依然爱我` confirms it as Mandopop). The artist-name match
 * can't catch these because the artist field itself is the anomaly. Keep this
 * list small and reviewed.
 *
 * Behavior
 * --------
 * 1. Load the corpus (KARAOKE_SONGS_JSON override honored — exported by
 *    `scripts/run-post-crawl-pipeline.mjs` when its --corpus flag is used).
 * 2. Import the drop-list predicates + splitter from the crawler dist.
 *    BUILD PREREQUISITE: `corepack pnpm --filter @karaoke/crawler build` must
 *    have run first (CI runs this script after `pnpm -r build`); a missing
 *    dist is a hard error (exit 2), not an auto-rebuild.
 * 3. For each record, drop if ANY component of `artist_primary` (per
 *    `splitArtistCollab` — the same decomposition the parser uses) matches
 *    the drop set, or — chinese pass — the record `id` is a catalog anomaly.
 * 4. Atomic-write the result back via `<file>.tmp` + rename (canonical
 *    pipeline byte-shape: indent=2 + trailing newline). When no records
 *    match, the corpus file is NOT rewritten — on-disk bytes survive
 *    untouched, preserving mtime and avoiding spurious diffs.
 * 5. Print a report: drop-list key count, totals before/after, dropped count,
 *    and a sample of 10 dropped (id, artist) pairs for spot-checking.
 *
 * Idempotent — running twice produces a no-op on the second run (no rewrite,
 * no mtime change).
 *
 * Usage
 * -----
 *   node scripts/drop-artist-leaks.mjs --list korean
 *   node scripts/drop-artist-leaks.mjs --list chinese
 *   node scripts/drop-artist-leaks.mjs --list korean --dry-run
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCorpusAtomic } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const CLUSTERING_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
const KOREAN_DIST = resolve(
  REPO_ROOT,
  'packages/crawler/dist/adapters/tj-media-direct/koreanArtistDropList.js',
);
const CHINESE_DIST = resolve(
  REPO_ROOT,
  'packages/crawler/dist/adapters/tj-media-direct/chineseArtistDropList.js',
);

/**
 * Catalog-anomaly IDs (chinese pass only): records where `artist_primary`
 * itself is malformed in the TJ source (e.g. literal `-`) so the artist-name
 * match cannot catch them. Keep this list small and reviewed.
 *   - tj-72638: artist literally `-`, title `明天你是否依然爱我` (simplified
 *     Chinese, confirmed Mandopop).
 *   - tj-71365: same catalog-anomaly family (2026-06 audit).
 */
export const CATALOG_ANOMALY_IDS = Object.freeze(new Set(['tj-72638', 'tj-71365']));

export const USAGE = 'usage: node scripts/drop-artist-leaks.mjs --list korean|chinese [--dry-run]';

/** Parse CLI args. Throws on unknown flags, missing values, or bad --list. */
export function parseArgs(argv) {
  const parsed = { list: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--list') {
      const value = argv[i + 1];
      if (!value) throw new Error('--list requires a value (korean|chinese)');
      if (value !== 'korean' && value !== 'chinese') {
        throw new Error(`--list must be korean or chinese, got: ${value}`);
      }
      parsed.list = value;
      i += 1;
    } else if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!parsed.help && parsed.list === null) {
    throw new Error('--list korean|chinese is required');
  }
  return parsed;
}

/**
 * Import the canonical predicates from the built crawler dist for the given
 * list name. Returns `{ isDropKey, keyCount, anomalyIds, normalizeForMatch,
 * splitArtistCollab }`. Throws (with the build hint) if the dist is missing.
 */
export async function loadListPredicates(list) {
  const distModule = list === 'korean' ? KOREAN_DIST : CHINESE_DIST;
  for (const path of [CLUSTERING_DIST, distModule]) {
    if (!existsSync(path)) {
      throw new Error(
        `missing crawler dist at ${path}\n  Run \`corepack pnpm --filter @karaoke/crawler build\` first.`,
      );
    }
  }
  const { normalizeForMatch, splitArtistCollab } = await import(
    pathToFileURL(CLUSTERING_DIST).href
  );
  const mod = await import(pathToFileURL(distModule).href);
  if (list === 'korean') {
    return {
      isDropKey: mod.isInDropList,
      keyCount: mod.DROP_KEY_SET.size,
      anomalyIds: new Set(),
      normalizeForMatch,
      splitArtistCollab,
    };
  }
  return {
    isDropKey: mod.isInChineseDropList,
    keyCount: mod.CHINESE_ARTIST_DROP_LIST.size,
    anomalyIds: CATALOG_ANOMALY_IDS,
    normalizeForMatch,
    splitArtistCollab,
  };
}

/**
 * True when any `splitArtistCollab` component of `artist` matches the drop
 * set. This is the SAME per-component scan `classifyRecord` runs at crawl
 * time (`drop-list-reject`), so corpus cleanup and parser agree by
 * construction.
 */
export function isArtistDropped(artist, { isDropKey, normalizeForMatch, splitArtistCollab }) {
  for (const component of splitArtistCollab(artist)) {
    if (isDropKey(normalizeForMatch(component))) return true;
  }
  return false;
}

/**
 * Partition `records` into kept / dropped per the drop predicate + anomaly
 * IDs. Pure — no I/O. Returns `{ kept, droppedCount, droppedSamples }` where
 * `droppedSamples` is the first 10 `[id, artist]` pairs.
 */
export function partitionCorpus(records, predicates) {
  const kept = [];
  const droppedSamples = [];
  let droppedCount = 0;
  for (const rec of records) {
    const recId = rec.id == null ? '' : String(rec.id);
    const artist = typeof rec.artist_primary === 'string' ? rec.artist_primary : '';
    if (predicates.anomalyIds.has(recId) || isArtistDropped(artist, predicates)) {
      droppedCount += 1;
      if (droppedSamples.length < 10) {
        droppedSamples.push([recId === '' ? '<no-id>' : recId, artist]);
      }
      continue;
    }
    kept.push(rec);
  }
  return { kept, droppedCount, droppedSamples };
}

/**
 * Run one drop pass. Mirrors the Python scripts' contract:
 *   exit 0 — clean run (including the no-op and dry-run paths)
 *   exit 2 — missing prerequisite (corpus, crawler dist, or an empty drop set)
 * No-op (zero drops) does NOT rewrite the corpus file.
 *
 * `predicates` is a test seam: when provided it replaces the
 * `loadListPredicates(list)` result so the zero-key guard is testable
 * without mutating the real dist.
 */
export async function runDropArtistLeaks({
  list,
  corpusPath,
  dryRun = false,
  log = console,
  predicates: injectedPredicates = null,
}) {
  if (!existsSync(corpusPath)) {
    log.error(`ERROR: missing corpus at ${corpusPath}`);
    return 2;
  }

  let predicates = injectedPredicates;
  if (predicates === null) {
    try {
      predicates = await loadListPredicates(list);
    } catch (err) {
      log.error(`ERROR: ${err.message}`);
      return 2;
    }
  }
  if (predicates.keyCount === 0) {
    // Fail-fast parity with the old Python scripts' empty-sidecar guard:
    // running with zero keys would be a silent no-op that wastes the step.
    log.error(`ERROR: ${list} drop list loaded zero keys from crawler dist`);
    return 2;
  }
  log.log(`loaded ${predicates.keyCount} ${list} drop-list keys (from crawler dist)`);

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));
  const totalBefore = corpus.length;
  const { kept, droppedCount, droppedSamples } = partitionCorpus(corpus, predicates);
  const totalAfter = kept.length;

  if (droppedCount === 0) {
    log.log('no records matched the drop list — corpus already clean (no-op)');
    return 0;
  }

  if (dryRun) {
    log.log(`dry-run — would drop: ${droppedCount} (before=${totalBefore} after=${totalAfter})`);
    log.log('sample (first 10 would-drop):');
    for (const [recId, artist] of droppedSamples) {
      log.log(`  ${recId}  ${JSON.stringify(artist)}`);
    }
    log.error('dry-run, no changes written');
    return 0;
  }

  // Atomic write (songs.json.tmp -> rename), canonical pipeline byte-shape.
  writeCorpusAtomic(corpusPath, kept);

  log.log(`total before: ${totalBefore}`);
  log.log(`total after:  ${totalAfter}`);
  log.log(`dropped:      ${droppedCount}`);
  log.log('sample (first 10 dropped):');
  for (const [recId, artist] of droppedSamples) {
    log.log(`  ${recId}  ${JSON.stringify(artist)}`);
  }
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
  // KARAOKE_SONGS_JSON: corpus-path override exported by
  // scripts/run-post-crawl-pipeline.mjs when its --corpus flag is used, so the
  // whole pipeline can be exercised against a copy. Unset in CI/default runs.
  const corpusPath = process.env.KARAOKE_SONGS_JSON
    ? resolve(process.env.KARAOKE_SONGS_JSON)
    : resolve(REPO_ROOT, 'apps/web/public/data/songs.json');
  process.exitCode = await runDropArtistLeaks({
    list: args.list,
    corpusPath,
    dryRun: args.dryRun,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`drop-artist-leaks failed: ${err.message}`);
    process.exitCode = 1;
  });
}
