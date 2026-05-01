import type { RawSongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import {
  type ArtistNationalityCode,
  type ArtistNationalityEntry,
  type SearchSongCache,
  isArtistNationalityFresh,
} from './cache.js';
import { normalizeForMatch, splitArtistCollab } from './normalize.js';
import { type SearchSongItem, searchSongByArtist } from './searchSong.js';

/**
 * Per-artist nationality scan.
 *
 * Iterates every distinct **component** name in the catalog. For each catalog
 * row, the `artist_primary` is split via `splitArtistCollab` so collab strings
 * like `imase & なとり`, `IDOLiSH7,TRIGGER,Re:vale`,
 * `Charlie Puth(Feat.宇多田ヒカル)`, or `安室奈美恵 with スーパーモンキーズ`
 * each yield independent component scans. Single-artist names round-trip
 * through the splitter unchanged. Across the 67k-record TJ catalog this
 * typically resolves to ~10-15k unique components.
 *
 * For each unique component (keyed by `normalizeForMatch` so we never
 * double-fetch a canonicalised duplicate):
 *
 *  1. If the cache already has a fresh `artistNationalityMap` entry, reuse it.
 *  2. Else: call `/legacy/api/searchSong?strType=2` (artist field) with the
 *     component name. Tally `nationalcode` votes from results that are an
 *     EXACT match on `normalize(item.indexSong) === normalize(component)`.
 *  3. Classify by the vote distribution:
 *       - all JPN votes (count ≥ 1)        -> JPN
 *       - all KOR votes                    -> KOR
 *       - all ENG votes                    -> ENG
 *       - mixed (e.g. JPN+KOR)             -> AMBIGUOUS
 *       - no exact-match votes at all      -> UNKNOWN
 *  4. Persist to cache. The caller (crawler.ts) is responsible for the
 *     `saveCache` call after the pass.
 *
 * The classification is intentionally conservative: a single non-JPN vote
 * downgrades a JPN-leaning artist to AMBIGUOUS. PR-2's filter chain treats
 * AMBIGUOUS as "drop unless rescued" — same as a hard KOR/ENG. Better to
 * miss a record (blog rescue catches it) than admit a Mandopop singer.
 *
 * Cost estimate: 10-15k components × 500 ms ≈ 1.4-2 h fresh; near-zero on
 * warm cache. Logs progress every 500 components with running counts.
 */

export interface EnrichArtistMapOptions {
  /** Override the date used for staleness checks. */
  now?: Date;
  /** Override the per-N-artists progress log cadence. Default 500. */
  progressEveryN?: number;
  /** Override the console used for log/warn output. */
  logger?: { log(msg: string): void; warn(msg: string): void };
}

export interface EnrichArtistMapStats {
  /**
   * Total distinct components processed. With the PR-4 collab splitter this
   * counts component names — a single record like `imase & なとり`
   * contributes 3 entries (whole + 2 splits) deduped against the rest.
   */
  totalArtists: number;
  /** Cache hits (skipped HTTP). */
  cacheHits: number;
  /** Successful HTTP calls. */
  fetches: number;
  /** Calls that threw (HTTP error, JSON, robots-disallow). */
  errors: number;
  /** Components classified by `code`. */
  byCode: Record<ArtistNationalityCode, number>;
}

export async function enrichArtistMap(
  http: Pick<HttpClient, 'postForm'>,
  records: ReadonlyArray<RawSongRecord>,
  cache: SearchSongCache,
  options: EnrichArtistMapOptions = {},
): Promise<EnrichArtistMapStats> {
  const now = options.now ?? new Date();
  const progressEveryN = options.progressEveryN ?? 500;
  const logger = options.logger ?? {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  // Build the unique-component set as a key->displayName Map. Each catalog
  // row's `artist_primary` is run through `splitArtistCollab` so that collab
  // strings (`imase & なとり`, `Charlie Puth(Feat.宇多田ヒカル)`, …) yield
  // independent component scans alongside the whole-string scan. Keys are
  // the canonical normalized form so the cache lookups line up with the
  // parser filter's lookup AND we never double-fetch (e.g. two records that
  // both contribute `imase` only fetch it once). The displayName is the
  // first occurrence we saw — used as the actual `searchTxt` value plus in
  // error messages.
  const artists = new Map<string, string>();
  for (const r of records) {
    const name = r.artist_primary;
    if (!name) continue;
    for (const component of splitArtistCollab(name)) {
      const key = normalizeForMatch(component);
      if (key === '') continue;
      if (!artists.has(key)) artists.set(key, component);
    }
  }

  const stats: EnrichArtistMapStats = {
    totalArtists: artists.size,
    cacheHits: 0,
    fetches: 0,
    errors: 0,
    byCode: { JPN: 0, KOR: 0, ENG: 0, AMBIGUOUS: 0, UNKNOWN: 0 },
  };

  let processed = 0;
  for (const [key, displayName] of artists) {
    processed++;

    // Cache hit fast path.
    if (isArtistNationalityFresh(cache, key, now)) {
      const entry = cache.artistNationalityMap[key];
      if (entry) {
        stats.cacheHits++;
        stats.byCode[entry.code]++;
        if (progressEveryN > 0 && processed % progressEveryN === 0) {
          logProgress(logger, processed, stats);
        }
        continue;
      }
    }

    let items: SearchSongItem[] = [];
    let fetchOk = false;
    try {
      items = await searchSongByArtist(http, displayName, '');
      fetchOk = true;
      stats.fetches++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[tj-artist] scan failed for "${displayName}" (key=${key}): ${msg}`);
      stats.errors++;
    }

    if (!fetchOk) {
      // On transport error, leave the cache entry untouched so a future
      // crawl retries. Don't write a stub; that would suppress retries for
      // 90 days and silently rot the artist.
      if (progressEveryN > 0 && processed % progressEveryN === 0) {
        logProgress(logger, processed, stats);
      }
      continue;
    }

    const entry = classifyVotes(items, key, now);
    cache.artistNationalityMap[key] = entry;
    stats.byCode[entry.code]++;

    if (progressEveryN > 0 && processed % progressEveryN === 0) {
      logProgress(logger, processed, stats);
    }
  }

  // Final summary line.
  logger.log(
    `[tj-artist] scan complete — ${stats.totalArtists} components: JPN=${stats.byCode.JPN} KOR=${stats.byCode.KOR} ENG=${stats.byCode.ENG} AMBIGUOUS=${stats.byCode.AMBIGUOUS} UNKNOWN=${stats.byCode.UNKNOWN} (cacheHits=${stats.cacheHits} fetches=${stats.fetches} errors=${stats.errors})`,
  );

  // Refresh `generatedAt` if we mutated anything.
  if (stats.fetches > 0) {
    cache.generatedAt = now.toISOString();
  }

  return stats;
}

function classifyVotes(
  items: ReadonlyArray<SearchSongItem>,
  artistKey: string,
  now: Date,
): ArtistNationalityEntry {
  const votes: { JPN: number; KOR: number; ENG: number } = { JPN: 0, KOR: 0, ENG: 0 };
  for (const item of items) {
    if (normalizeForMatch(item.indexSong) !== artistKey) continue;
    const code = item.nationalcode;
    if (code === 'JPN' || code === 'KOR' || code === 'ENG') {
      votes[code]++;
    }
    // Other codes (null, empty, unfamiliar) ignored. Don't count them as
    // anything — the artist may have non-tagged-up entries on TJ side.
  }

  const verdict = verdictFromVotes(votes);
  return { code: verdict, votes, lastSeen: now.toISOString() };
}

/**
 * Verdict rule (Phase 1 spec §2.A — KPOP-leak fix, 2026-05-01):
 *
 *   - JPN: `JPN ≥ 3 AND JPN/(JPN+KOR) ≥ 0.7`
 *   - KOR: `KOR ≥ 3 AND KOR/(JPN+KOR) ≥ 0.7` (symmetric — needed because
 *          spec §2.F now seeds KOR votes via the KPOP-chart sweep, so the
 *          rule has data to work with on both sides).
 *   - AMBIGUOUS: both JPN and KOR have ≥3 votes but neither hits the 0.7
 *                ratio (mixed-evidence artist).
 *   - ENG: `ENG ≥ 1 AND JPN == 0 AND KOR == 0` (English-only signal).
 *   - UNKNOWN: insufficient signal (no JPN/KOR/ENG votes, or below the
 *              threshold/ratio bar with no other tie-breaker).
 *
 * Why ≥3 + 0.7 (not the prior `JPN ≥ 1 AND KOR == 0`): the histogram across
 * all 1,532 JPN-coded artists at spec time was 818 with `JPN=1`, 224 with
 * `JPN=2`, 144 with `JPN=3`. `JPN ≥ 3` demotes ~68% to AMBIGUOUS purely on
 * threshold; per-`pro` `nationalcode === 'JPN'` rescue (parser path 3) still
 * catches the long-tail real-JP records via specific-pro confirmation.
 *
 * Why symmetric for KOR: spec §2.F's KPOP-chart bootstrap actively sources
 * KOR votes (which were empirically zero across all JPN-coded artists pre-
 * fix). The symmetric rule lets a KPOP chart sweep tag `방탄소년단` confidently
 * KOR even when an old JPOP-chart vote is still on file.
 */
function verdictFromVotes(votes: {
  JPN: number;
  KOR: number;
  ENG: number;
}): ArtistNationalityCode {
  const { JPN, KOR, ENG } = votes;
  const total = JPN + KOR;

  // JPN: ≥3 votes AND ≥0.7 ratio of JPN/(JPN+KOR). When KOR is 0 the ratio is 1.0.
  if (JPN >= 3 && total > 0 && JPN / total >= 0.7) return 'JPN';

  // KOR: symmetric rule — ≥3 votes AND ≥0.7 ratio of KOR/(JPN+KOR).
  if (KOR >= 3 && total > 0 && KOR / total >= 0.7) return 'KOR';

  // AMBIGUOUS: both sides have ≥3 votes but neither side hit the 0.7 ratio.
  // Mixed-evidence artist; the parser filter rejects these (only JPN admits).
  if (JPN >= 3 && KOR >= 3) return 'AMBIGUOUS';

  // ENG: English-only signal. Preserved from the previous rule — an artist
  // with ENG votes and zero JPN/KOR votes is tagged ENG so the parser knows
  // this is not a Japanese act. ENG votes alongside JPN/KOR votes (rare in
  // practice) fall through to UNKNOWN, which the parser also rejects.
  if (ENG > 0 && JPN === 0 && KOR === 0) return 'ENG';

  // UNKNOWN: insufficient signal. Includes:
  //   - 0/0/0 (no exact-match votes at all)
  //   - JPN=1 KOR=0 / JPN=2 KOR=0 (below threshold)
  //   - JPN=4 KOR=2 (4 votes, ratio 0.67 < 0.7, KOR side has only 2 votes —
  //     not symmetric AMBIGUOUS)
  // Parser filter rejects these; per-`pro` JPN rescue still catches real
  // long-tail JP records via specific-pro confirmation.
  return 'UNKNOWN';
}

function logProgress(
  logger: { log(msg: string): void },
  processed: number,
  stats: EnrichArtistMapStats,
): void {
  logger.log(
    `[tj-artist] scanned ${processed}/${stats.totalArtists} components — JPN=${stats.byCode.JPN} KOR=${stats.byCode.KOR} ENG=${stats.byCode.ENG} AMBIG=${stats.byCode.AMBIGUOUS} UNK=${stats.byCode.UNKNOWN} (hits=${stats.cacheHits} fetches=${stats.fetches} errors=${stats.errors})`,
  );
}
