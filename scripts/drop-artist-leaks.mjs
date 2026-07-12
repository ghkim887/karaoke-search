#!/usr/bin/env node
/**
 * One-shot + re-runnable corpus cleanup: drop records whose artist matches
 * the Korean-artist or Chinese-artist (Cantopop / Mandopop) drop list, plus a
 * small per-pass set of catalog-anomaly IDs (rows the artist-name match cannot
 * catch).
 *
 * Replaces the former Python pair `scripts/drop_kpop_leaks.py` /
 * `scripts/drop_cpop_leaks.py`. Those scripts consumed JSON sidecars
 * (re-exports of the TS drop lists) plus a hand-mirrored Python copy of the
 * artist splitter because Python cannot import the TS source. This script
 * imports the canonical implementations straight from the built crawler dist
 * (`isInDropList` / `isInChineseDropList` / `normalizeForMatch` /
 * `splitArtistCollab` / `isReviewedTjSongAllow`) — zero parity machinery for the
 * Chinese list. The Korean sidecar JSON has no runtime reader anymore (both this
 * script and `scripts/ingest-tjpdf-catalog.mjs` read the built dist); it stays
 * only as a build-time drift-visibility guard.
 *
 * Parity scope: this tool mirrors the crawl-time filter chain's `curated-allow`
 * (reviewed-song-allow) and `deny-list` (drop-list-reject) steps — an artist-name
 * match drops a row UNLESS its TJ number is reviewed-song-allow-listed, exactly as
 * the chain admits reviewed songs (step 2) before the drop-list reject (step 3).
 * It does NOT reproduce the chain's cache-driven steps (reviewed-song-drop,
 * non-jpn-pro-reject, jpn-admit-pro/artist, blog-rescue): those need the searchSong
 * enrichment cache, which the corpus-cleanup path deliberately does not load. So
 * this is a subset of `classifyRecord`, not the full predicate.
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
 * Catalog-anomaly IDs (per pass)
 * ------------------------------
 * A small hardcoded list of TJ IDs the artist-name match can't catch because
 * the artist field itself is not a drop-list signal. Two flavours, each scoped
 * to one pass:
 *   - chinese (`CATALOG_ANOMALY_IDS`): `artist_primary` is malformed in the TJ
 *     source (e.g. literal `-` for tj-72638, a record whose simplified-Chinese
 *     title `明天你是否依然爱我` confirms it as Mandopop).
 *   - korean (`KOREAN_CATALOG_ANOMALY_IDS`): `artist_primary` is a legitimate
 *     Japanese act (must stay admittable) but the specific TJ row is a
 *     Korean-catalog placement (e.g. tj-70438 CUTIE STREET's KOR-language row).
 * Keep both lists small and reviewed.
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
 *    the drop set, or the record `id` is a catalog anomaly for this pass.
 *    EXCEPTION: an artist-name match is spared when the record's TJ number is
 *    reviewed-song-allow-listed (`isReviewedTjSongAllow`) — the curated
 *    exact-TJ K-pop Japanese releases. The catalog-anomaly drop is NOT spared.
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
 *   node scripts/drop-artist-leaks.mjs --list korean --decisions-out drop.jsonl
 *
 * --decisions-out <path> (optional): also write a JSONL decision log of the
 * DROPPED rows only (one `{ id, title, artist, decision:'drop',
 * step:'drop-artist-leaks', reason }` per line; reason ∈ korean-drop-list |
 * chinese-drop-list | catalog-anomaly-id). Report-only sidecar; unset = no file
 * written, behavior unchanged. Wired by scripts/run-post-crawl-pipeline.mjs when
 * FILTER_DECISIONS_DIR is set.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus, writeCorpusAtomic } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const CLUSTERING_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
const KOREAN_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/curated/koreanArtistDropList.js');
const CHINESE_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/curated/chineseArtistDropList.js');
const REVIEWED_OVERRIDES_DIST = resolve(
  REPO_ROOT,
  'packages/crawler/dist/adapters/tj-media-direct/reviewedSongOverrides.js',
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

/**
 * Catalog-anomaly IDs (korean pass only): records whose `artist_primary` is a
 * legitimate *Japanese* act — so the artist-name match neither does nor SHOULD
 * catch them — but whose specific TJ row is a Korean-catalog placement that
 * must drop by exact ID. Mirrors the crawl chain's reviewed-song-drop (step 0)
 * for the same TJ number (drop-artist-leaks does not load the cache, so it
 * re-applies these anomalies here instead). Keep this list small and reviewed.
 *   - tj-70438: "프리큐큐" / CUTIE STREET — Korean-language ver. of the JP
 *     single ぷりきゅきゅ (KR release 2026-06-06). CUTIE STREET is Japanese
 *     (ASOBISYSTEM / KAWAII LAB.) and stays admittable for their JP-language
 *     rows; only this KOR-tagged Korean-catalog row drops.
 */
export const KOREAN_CATALOG_ANOMALY_IDS = Object.freeze(new Set(['tj-70438']));

export const USAGE =
  'usage: node scripts/drop-artist-leaks.mjs --list korean|chinese [--dry-run] [--decisions-out <path>]';

/** Parse CLI args. Throws on unknown flags, missing values, or bad --list. */
export function parseArgs(argv) {
  const parsed = { list: null, dryRun: false, decisionsOut: null, help: false };
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
    } else if (arg === '--decisions-out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--decisions-out requires a path argument');
      parsed.decisionsOut = value;
      i += 1;
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
  for (const path of [CLUSTERING_DIST, distModule, REVIEWED_OVERRIDES_DIST]) {
    if (!existsSync(path)) {
      throw new Error(
        `missing crawler dist at ${path}\n  Run \`corepack pnpm --filter @karaoke/crawler build\` first.`,
      );
    }
  }
  const { normalizeForMatch, splitArtistCollab } = await import(
    pathToFileURL(CLUSTERING_DIST).href
  );
  // Reviewed-song-allow (curated-allow) is TJ-number-level and list-agnostic, so
  // it is imported once and wired into both list modes uniformly — mirroring the
  // crawl chain, where the single reviewed-song-allow step precedes the combined
  // Korean+Chinese drop-list-reject step.
  const { isReviewedTjSongAllow } = await import(pathToFileURL(REVIEWED_OVERRIDES_DIST).href);
  const mod = await import(pathToFileURL(distModule).href);
  if (list === 'korean') {
    return {
      isDropKey: mod.isInDropList,
      keyCount: mod.DROP_KEY_SET.size,
      anomalyIds: KOREAN_CATALOG_ANOMALY_IDS,
      isReviewedAllow: isReviewedTjSongAllow,
      dropReason: dropReasonForList('korean'),
      normalizeForMatch,
      splitArtistCollab,
    };
  }
  return {
    isDropKey: mod.isInChineseDropList,
    keyCount: mod.CHINESE_ARTIST_DROP_LIST.size,
    anomalyIds: CATALOG_ANOMALY_IDS,
    isReviewedAllow: isReviewedTjSongAllow,
    dropReason: dropReasonForList('chinese'),
    normalizeForMatch,
    splitArtistCollab,
  };
}

/**
 * The drop-list reason token for a given `--list` pass, matching the crawl
 * chain's `drop-list-reject` reasons (`korean-drop-list` / `chinese-drop-list`).
 */
export function dropReasonForList(list) {
  return list === 'korean' ? 'korean-drop-list' : 'chinese-drop-list';
}

/**
 * The drop reason when any `splitArtistCollab` component of `artist` matches
 * the drop set, else `null`. This is the SAME per-component scan
 * `classifyRecord` runs at crawl time (`drop-list-reject`), so corpus cleanup
 * and parser agree by construction. The reason (`predicates.dropReason`) tells
 * the caller WHICH check matched so the decision log can attribute the drop.
 */
export function isArtistDropped(
  artist,
  { isDropKey, normalizeForMatch, splitArtistCollab, dropReason },
) {
  for (const component of splitArtistCollab(artist)) {
    if (isDropKey(normalizeForMatch(component))) return dropReason ?? 'drop-list';
  }
  return null;
}

/**
 * Partition `records` into kept / dropped per the drop predicate + anomaly
 * IDs. Pure — no I/O. Returns `{ kept, droppedCount, droppedSamples,
 * droppedDecisions }` where `droppedSamples` is the first 10 `[id, artist]`
 * pairs and `droppedDecisions` is one attribution record per dropped row
 * (`{ id, title, artist, decision:'drop', step:'drop-artist-leaks', reason }`),
 * mirroring the crawl-time TJ filter decision log. The reason is
 * `catalog-anomaly-id` for an anomaly-ID drop, else the list's drop reason
 * (`korean-drop-list` / `chinese-drop-list`).
 *
 * reviewed-song-allow: a row that the artist deny-list would drop is SPARED when
 * its TJ karaoke number is on the reviewed-song allow-list (`isReviewedAllow`).
 * This mirrors the crawl-time filter chain, where reviewed-song-allow (step 2)
 * precedes drop-list-reject (step 3): a hand-audited K-pop / Korean-artist
 * Japanese release keyed by exact TJ number survives the artist-name drop. The
 * catalog-anomaly hard-drop (either pass) is NOT spared — those rows are dropped
 * by exact TJ ID regardless of artist, closer to the chain's hard-drop phase.
 */
export function partitionCorpus(records, predicates) {
  const kept = [];
  const droppedSamples = [];
  const droppedDecisions = [];
  let droppedCount = 0;
  const recordDrop = (rec, recId, artist, reason) => {
    droppedCount += 1;
    if (droppedSamples.length < 10) {
      droppedSamples.push([recId === '' ? '<no-id>' : recId, artist]);
    }
    droppedDecisions.push({
      id: recId,
      title: typeof rec.title_primary === 'string' ? rec.title_primary : '',
      artist,
      decision: 'drop',
      step: 'drop-artist-leaks',
      reason,
    });
  };
  for (const rec of records) {
    const recId = rec.id == null ? '' : String(rec.id);
    const artist = typeof rec.artist_primary === 'string' ? rec.artist_primary : '';
    if (predicates.anomalyIds.has(recId)) {
      recordDrop(rec, recId, artist, 'catalog-anomaly-id');
      continue;
    }
    const dropReason = isArtistDropped(artist, predicates);
    if (dropReason !== null) {
      const tj = typeof rec.karaoke_numbers?.tj === 'string' ? rec.karaoke_numbers.tj : '';
      const reviewedAllow = tj !== '' && predicates.isReviewedAllow?.(tj) === true;
      if (!reviewedAllow) {
        recordDrop(rec, recId, artist, dropReason);
        continue;
      }
    }
    kept.push(rec);
  }
  return { kept, droppedCount, droppedSamples, droppedDecisions };
}

/**
 * Write the dropped-row decision log as JSONL (one compact object per line),
 * overwrite semantics; an empty file when nothing dropped. The parent dir is
 * created if missing (CI points this at a RUNNER_TEMP subdir). Fail-soft: a
 * write error is warned via `log.error` and never propagates — the decision
 * log is report-only and must not fail the pass.
 */
function writeDroppedDecisions(outPath, decisions, log) {
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    const body = decisions.map((d) => JSON.stringify(d)).join('\n');
    writeFileSync(outPath, decisions.length > 0 ? `${body}\n` : '', 'utf-8');
    log.log(`wrote ${decisions.length} drop decisions to ${outPath}`);
  } catch (err) {
    log.error(`WARN: could not write decision log to ${outPath}: ${err.message}`);
  }
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
 *
 * `decisionsOut` (optional): when set, a JSONL decision log of the DROPPED
 * rows only is written there (one `{ id, title, artist, decision:'drop',
 * step:'drop-artist-leaks', reason }` per line; an empty file when nothing
 * dropped). Admits are the surviving corpus, so logging them here would be
 * waste. Fail-soft — a write error is warned, never fatal. Unset (the default,
 * and all local runs) = no file written, behavior unchanged.
 */
export async function runDropArtistLeaks({
  list,
  corpusPath,
  dryRun = false,
  log = console,
  predicates: injectedPredicates = null,
  decisionsOut = null,
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

  const corpus = loadCorpus(corpusPath);
  const totalBefore = corpus.length;
  const { kept, droppedCount, droppedSamples, droppedDecisions } = partitionCorpus(
    corpus,
    predicates,
  );
  const totalAfter = kept.length;

  // Write the decision log (dropped rows only) BEFORE the no-op early return so
  // a clean pass still emits an accurate empty file rather than a missing one.
  // Independent of dry-run: it reflects what the pass dropped, not the corpus
  // rewrite.
  if (decisionsOut) {
    writeDroppedDecisions(decisionsOut, droppedDecisions, log);
  }

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
    decisionsOut: args.decisionsOut ? resolve(args.decisionsOut) : null,
  });
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(`drop-artist-leaks failed: ${err.message}`);
    process.exitCode = 1;
  });
}
