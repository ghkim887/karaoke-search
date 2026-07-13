#!/usr/bin/env node
/**
 * Offline tjpdf catalog ingest (ROADMAP R7) — replaces the retired
 * `scripts/ingest_anisong_pdf.py` PDF post-step in the weekly pipeline
 * (scripts/run-post-crawl-pipeline.mjs). It reads the committed catalog JSONL
 * produced on-demand by `scripts/probe-tjpdf-catalog.mjs` (the TJ searchSong
 * number-probe) and inserts `tjpdf-<code>` coverage records into the corpus.
 *
 * This step is OFFLINE and DETERMINISTIC: it never touches the network — all
 * TJ data has already been captured into the committed catalog by the probe.
 *
 * Semantics — a faithful reproduction of ingest_anisong_pdf.py's main(),
 * changed ONLY in title/field sourcing (PDF → API):
 *   - IDs: `tjpdf-<code>` (unchanged — derived from the TJ number, so the LLM
 *     translation cache, manual-fix guards, Tier-F pairs, and parity baselines
 *     key by the same ids).
 *   - Coverage-only: a catalog code is inserted only when NO other corpus row
 *     already carries that TJ number.
 *   - Refresh: every existing `tjpdf-*` row is dropped up-front and re-inserted
 *     from the catalog, so retired numbers fall out and titles refresh.
 *   - crawled_at is harvested from the dropped row (keyed by TJ number) and
 *     carried forward for byte-idempotency; genuinely-new codes get a fresh
 *     ISO timestamp.
 *   - artist_aliases are carried forward from the dropped row, but only when the
 *     artist is unchanged (normalizeForMatch equality) — a genuinely-different
 *     artist declines potentially-stale aliases (mirrors the python ingest).
 *   - Korean-artist drop-list filter at insert: a catalog artist matching the
 *     curated Korean drop list never mints a `tjpdf-*` row (the KOREAN drop list
 *     is loaded from the built crawler dist — the same canonical predicate
 *     `scripts/drop-artist-leaks.mjs` uses; graceful-degrades to no-filter if the
 *     dist is missing, since the later `drop-kpop-leaks` pipeline step catches
 *     leaks anyway).
 *
 * FIELD-SOURCING DECISIONS (per ROADMAP R7 "NON-goal" + the #122 title-blast
 * lesson):
 *   - title_primary  = catalog `indexTitle` VERBATIM. This keeps the API's
 *     tie-up parentheses (e.g. `…(パタリロ西遊記! OP)`), consistent with the
 *     `tj-*` source convention, and the API titles are already clean — the two
 *     pdftotext column-leak corruptions the old ingest hand-repaired
 *     (`_TITLE_OVERRIDES` for 28477/68430) come back intact from the API, so no
 *     override map is needed.
 *   - artist_primary = catalog `indexSong`.
 *   - title_ko       = null → LEFT FOR THE STAGE-2 LLM LANE. The API's
 *     `sortTitleKo` is a katakana→hangul SORT helper (a phonetic reading with
 *     media-context fragments), exactly the class Stage 1 strips as "not a
 *     translation"; it is NOT a Korean title. Setting null here is the same
 *     end-state the old ingest reached (it wrote a PDF transliteration that
 *     `normalize_tj_title_ko.py` Stage 1 then nulled). The title_ko lane
 *     (Stage-2 replay + manual fixes) owns this field; this ingest does not
 *     touch lane logic.  NB: the Stage-2 replay cache is ALSO title-GUARDED (it
 *     NFKC-compares each cached entry's stored `title_primary` before
 *     re-applying its translation — translate_title_ko_via_agents.mjs:133-141),
 *     so the mass title change was matched by a one-time MECHANICAL re-key of
 *     the cache's stored `title_primary` to the API titles (ROADMAP R7 Option
 *     2; translations byte-preserved). Stage-2 therefore re-applies every
 *     existing tjpdf translation, and a consistency pin
 *     (ingest-tjpdf-catalog.test.mjs) keeps the cache and the catalog from
 *     drifting apart. See the PR body's cache-keying finding.
 *   - artist_ko      = catalog `sortSongKo` VERBATIM (empty/whitespace → null).
 *     This is the TJ Korean phonetic reading of the artist and is exactly the
 *     field `tj-*` rows already source from the same API
 *     (adapters/tj-media-direct/normalizer.ts:47 `sortSongKo ?? null`), so tjpdf
 *     now matches its sibling channel. artist_ko IS the phonetic reading, NOT a
 *     translation, and is on NO LLM lane — the "phonetic reading, not a
 *     translation" rule that (correctly) keeps title_ko null for the Stage-2
 *     lane above was previously over-applied here.  The prior "preserve from the
 *     dropped row" scheme is empirically DEAD in the weekly pipeline: the ingest
 *     runs over a FRESH crawl corpus carrying ZERO `tjpdf-*` rows, so nothing is
 *     ever harvested and every re-minted row got artist_ko=null unless a
 *     same-artist merger happened to refill it (crawl #138: 181 readings lost).
 *     Sourcing from the catalog row keeps the field genuinely populated. No
 *     staleness guard is needed — `sortSongKo` and `indexSong` come from the
 *     same catalog row, so an artist change updates the reading in lockstep.
 *   - source_url     = the searchSong API URL (the data's actual source now),
 *     replacing the old poster-PDF support URL.
 *
 * No `.omc/anisong_ingest_report.txt` is written (the old report was gitignored
 * and read by nothing); a summary line is printed to stdout for log parity.
 *
 * Exit codes: 0 success; 2 missing catalog/corpus; 1 malformed catalog.
 *
 * Corpus path: `KARAOKE_SONGS_JSON` env override (exported by
 * run-post-crawl-pipeline.mjs --corpus) else apps/web/public/data/songs.json.
 *
 * Usage: node scripts/ingest-tjpdf-catalog.mjs [--catalog <path>] [--corpus <path>]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus, writeCorpusAtomic } from './lib/corpus.mjs';
import { readCatalog } from './probe-tjpdf-catalog.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

export const DEFAULT_CATALOG_PATH = resolve(REPO_ROOT, 'scripts/data/tjpdf-catalog.jsonl');
export const DEFAULT_CORPUS_PATH = resolve(REPO_ROOT, 'apps/web/public/data/songs.json');
// Provenance: the data now comes from the TJ legacy searchSong API, not the
// manually-downloaded poster PDF.
export const SOURCE_URL = 'https://www.tjmedia.com/legacy/api/searchSong';

const CLUSTERING_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
const KOREAN_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/curated/koreanArtistDropList.js');

/** Local NFKC/case/whitespace fold — fallback for the artist-identity guard
 *  when the crawler dist (canonical `normalizeForMatch`) is unavailable. */
export function localNormalizeForMatch(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * Load the Korean drop-list predicate + `normalizeForMatch` + `splitArtistCollab`
 * from the built crawler dist. Returns `null` (graceful degradation, warn) when
 * the dist is absent — the later `drop-kpop-leaks` pipeline step still catches
 * any leak. Mirrors `scripts/drop-artist-leaks.mjs`.
 */
export async function loadDropPredicates(log = console) {
  for (const p of [CLUSTERING_DIST, KOREAN_DIST]) {
    if (!existsSync(p)) {
      log.error(
        `WARN: crawler dist not found at ${p} — Korean drop-list filter DISABLED for this ingest (the drop-kpop-leaks pipeline step still applies it). Run \`corepack pnpm --filter @karaoke/crawler build\` to enable it here.`,
      );
      return null;
    }
  }
  const { normalizeForMatch, splitArtistCollab } = await import(
    pathToFileURL(CLUSTERING_DIST).href
  );
  const { isInDropList } = await import(pathToFileURL(KOREAN_DIST).href);
  return { isInDropList, normalizeForMatch, splitArtistCollab };
}

/**
 * Build an artist-drop predicate + normalizer bundle for the pure core. When
 * `dropPredicates` is null (dist missing), the drop check is a no-op and the
 * identity guard uses the local fold.
 */
export function makeIngestPredicates(dropPredicates) {
  if (dropPredicates === null) {
    return { isArtistDropped: () => false, normalizeForMatch: localNormalizeForMatch };
  }
  const { isInDropList, normalizeForMatch, splitArtistCollab } = dropPredicates;
  // Same per-component scan as classifyRecord's drop-list-reject and
  // drop-artist-leaks.mjs (splitArtistCollab → normalizeForMatch → isInDropList).
  const isArtistDropped = (artist) => {
    for (const component of splitArtistCollab(artist)) {
      if (isInDropList(normalizeForMatch(component))) return true;
    }
    return false;
  };
  return { isArtistDropped, normalizeForMatch };
}

/** ISO-8601 UTC ms + Z, matching iso_utc_now() / JS toISOString(). */
export function isoUtcNow() {
  return new Date().toISOString();
}

/**
 * Validate a catalog entry has the identifiers the ingest needs. Throws on a
 * malformed entry (defensive — the probe guarantees these, but a hand-edited
 * catalog should fail loud rather than silently drop coverage).
 */
export function assertCatalogEntry(entry, index) {
  for (const f of ['pro', 'indexTitle', 'indexSong']) {
    if (typeof entry[f] !== 'string' || entry[f] === '') {
      throw new Error(
        `catalog entry #${index} missing/empty required field "${f}": ${JSON.stringify(entry)}`,
      );
    }
  }
}

/**
 * Pure core: given the parsed catalog + corpus, return the new corpus array and
 * ingest stats. No I/O. `predicates` = { isArtistDropped, normalizeForMatch };
 * `nowIso` is injectable for deterministic tests.
 */
export function buildIngestedCorpus(
  catalogEntries,
  corpus,
  { isArtistDropped, normalizeForMatch, nowIso = isoUtcNow, sourceUrl = SOURCE_URL },
) {
  // Validate the catalog up-front: required identifier fields + unique `pro`.
  // The probe writes a unique catalog by construction, but the file is
  // hand-editable — fail fast (naming the offending code) rather than silently
  // inserting a duplicate/garbage tjpdf row.
  const seenPro = new Set();
  for (let i = 0; i < catalogEntries.length; i += 1) {
    assertCatalogEntry(catalogEntries[i], i);
    const pro = catalogEntries[i].pro;
    if (seenPro.has(pro)) {
      throw new Error(`catalog has a duplicate pro "${pro}" (entry #${i}) — codes must be unique`);
    }
    seenPro.add(pro);
  }

  // Harvest carry-forward fields from existing tjpdf-* rows, keyed by TJ number.
  // (artist_ko is NOT harvested — it is sourced fresh from the catalog below.)
  const oldCrawledAt = new Map();
  const oldAliases = new Map();
  const oldArtistPrimary = new Map();
  for (const r of corpus) {
    if (!String(r.id ?? '').startsWith('tjpdf-')) continue;
    const tj = r.karaoke_numbers?.tj;
    if (!tj) continue;
    if (r.crawled_at) oldCrawledAt.set(tj, r.crawled_at);
    if (Array.isArray(r.artist_aliases) && r.artist_aliases.length > 0) {
      oldAliases.set(tj, [...r.artist_aliases]);
    }
    if (r.artist_primary) oldArtistPrimary.set(tj, r.artist_primary);
  }

  // Idempotent pre-pass: drop every existing tjpdf-* row.
  let droppedOld = 0;
  const kept = [];
  for (const r of corpus) {
    if (String(r.id ?? '').startsWith('tjpdf-')) {
      droppedOld += 1;
      continue;
    }
    kept.push(r);
  }

  // TJ numbers still present on non-tjpdf rows — coverage-only skips these.
  const tjPresent = new Set();
  for (const r of kept) {
    const tj = r.karaoke_numbers?.tj;
    if (tj) tjPresent.add(tj);
  }

  let alreadyInCorpus = 0;
  let droppedArtist = 0;
  const titleFallbacks = [];
  const newRecords = [];

  for (let i = 0; i < catalogEntries.length; i += 1) {
    const entry = catalogEntries[i];
    const code = entry.pro;

    if (tjPresent.has(code)) {
      alreadyInCorpus += 1;
      continue;
    }
    const artist = entry.indexSong;
    if (isArtistDropped(artist)) {
      droppedArtist += 1;
      continue;
    }

    // title_primary = indexTitle verbatim; defensive fallback to artist only if
    // a hand-edited catalog somehow carries an empty title (probe guarantees not).
    const title = entry.indexTitle || artist;
    if (!entry.indexTitle) titleFallbacks.push(code);

    const artistChanged =
      oldArtistPrimary.has(code) &&
      normalizeForMatch(oldArtistPrimary.get(code)) !== normalizeForMatch(artist);

    let aliases = oldAliases.get(code);
    if (aliases && artistChanged) aliases = undefined;

    // artist_ko = the catalog's TJ phonetic reading (sortSongKo), the same field
    // tj-* rows carry. Empty / whitespace-only → null. No staleness guard: it
    // comes from the same catalog row as indexSong, so it can never be stale.
    const artistKo =
      typeof entry.sortSongKo === 'string' && entry.sortSongKo.trim() !== ''
        ? entry.sortSongKo
        : null;

    const crawledAt = oldCrawledAt.get(code) || nowIso();

    // Canonical key order (matches the merger emission + the old ingest):
    // id, source_url, title_primary, title_ko, artist_primary, artist_ko,
    // [artist_aliases], karaoke_numbers, crawled_at.
    const rec = {
      id: `tjpdf-${code}`,
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: artist,
      artist_ko: artistKo,
    };
    if (aliases && aliases.length > 0) rec.artist_aliases = aliases;
    rec.karaoke_numbers = { tj: code, ky: null, joysound: null };
    rec.crawled_at = crawledAt;
    newRecords.push(rec);
  }

  return {
    corpus: [...kept, ...newRecords],
    stats: {
      catalogSize: catalogEntries.length,
      droppedOld,
      alreadyInCorpus,
      droppedArtist,
      inserted: newRecords.length,
      titleFallbacks,
    },
  };
}

/**
 * I/O wrapper around the pure core. `predicates` is a test seam replacing the
 * dist-loaded drop predicates.
 */
export function runIngest({
  catalogPath,
  corpusPath,
  predicates,
  nowIso = isoUtcNow,
  log = console,
}) {
  if (!existsSync(catalogPath)) {
    log.error(`ERROR: missing catalog at ${catalogPath}`);
    return 2;
  }
  if (!existsSync(corpusPath)) {
    log.error(`ERROR: missing corpus at ${corpusPath}`);
    return 2;
  }

  const catalogEntries = readCatalog(catalogPath);
  if (catalogEntries.length === 0) {
    log.error(`ERROR: catalog at ${catalogPath} is empty`);
    return 1;
  }
  const corpus = loadCorpus(corpusPath);

  let result;
  try {
    result = buildIngestedCorpus(catalogEntries, corpus, { ...predicates, nowIso });
  } catch (err) {
    log.error(`ERROR: ${err.message}`);
    return 1;
  }

  writeCorpusAtomic(corpusPath, result.corpus);

  const s = result.stats;
  log.log(
    `ingest-tjpdf-catalog: catalog=${s.catalogSize} dropped_old_tjpdf=${s.droppedOld} ` +
      `already_in_corpus=${s.alreadyInCorpus} inserted=${s.inserted} ` +
      `dropped_artist=${s.droppedArtist} title_fallbacks=${s.titleFallbacks.length}`,
  );
  return 0;
}

export function parseArgs(argv) {
  const parsed = { catalogPath: DEFAULT_CATALOG_PATH, corpusPath: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--catalog') {
      const v = argv[i + 1];
      if (!v) throw new Error('--catalog requires a path');
      parsed.catalogPath = resolve(v);
      i += 1;
    } else if (arg === '--corpus') {
      const v = argv[i + 1];
      if (!v) throw new Error('--corpus requires a path');
      parsed.corpusPath = resolve(v);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export const USAGE =
  'usage: node scripts/ingest-tjpdf-catalog.mjs [--catalog <path>] [--corpus <path>]';

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

  // Corpus resolution order: explicit --corpus > KARAOKE_SONGS_JSON > default.
  const corpusPath =
    args.corpusPath ??
    (process.env.KARAOKE_SONGS_JSON
      ? resolve(process.env.KARAOKE_SONGS_JSON)
      : DEFAULT_CORPUS_PATH);

  const dropPredicates = await loadDropPredicates();
  const predicates = makeIngestPredicates(dropPredicates);
  process.exitCode = runIngest({ catalogPath: args.catalogPath, corpusPath, predicates });
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(`ingest-tjpdf-catalog failed: ${err.message}`);
    process.exitCode = 1;
  });
}
