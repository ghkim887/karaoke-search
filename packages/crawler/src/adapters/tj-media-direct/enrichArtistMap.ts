import type { RawSongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import {
  type ArtistNationalityCode,
  type ArtistNationalityEntry,
  type SearchSongCache,
  isArtistNationalityFresh,
} from './cache.js';
import { normalizeForMatch } from './normalize.js';
import { type SearchSongItem, searchSongByArtist } from './searchSong.js';

/**
 * Per-artist nationality scan.
 *
 * Iterates every distinct artist in the catalog (typically ~10-15k unique
 * `artist_primary` values across the 67k-record TJ catalog). For each artist:
 *
 *  1. If the cache already has a fresh `artistNationalityMap` entry, reuse it.
 *  2. Else: call `/legacy/api/searchSong?strType=2` (artist field) with the
 *     artist name. Tally `nationalcode` votes from results that are an
 *     EXACT match on `normalize(item.indexSong) === normalize(artist)`.
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
 * Cost estimate: 10-15k artists × 500 ms ≈ 1.4-2 h fresh; near-zero on warm
 * cache. Logs progress every 500 artists with running counts.
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
  /** Total distinct artists processed. */
  totalArtists: number;
  /** Cache hits (skipped HTTP). */
  cacheHits: number;
  /** Successful HTTP calls. */
  fetches: number;
  /** Calls that threw (HTTP error, JSON, robots-disallow). */
  errors: number;
  /** Artists classified by `code`. */
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

  // Build the unique-artist set as a key->displayName Map. Keys are the
  // canonical normalized form so the cache lookups line up with the parser
  // filter's lookup. The displayName is the first occurrence we saw — used
  // in error messages only.
  const artists = new Map<string, string>();
  for (const r of records) {
    const name = r.artist_primary;
    if (!name) continue;
    const key = normalizeForMatch(name);
    if (key === '') continue;
    if (!artists.has(key)) artists.set(key, name);
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
    `[tj-artist] scan complete — ${stats.totalArtists} artists: JPN=${stats.byCode.JPN} KOR=${stats.byCode.KOR} ENG=${stats.byCode.ENG} AMBIGUOUS=${stats.byCode.AMBIGUOUS} UNKNOWN=${stats.byCode.UNKNOWN} (cacheHits=${stats.cacheHits} fetches=${stats.fetches} errors=${stats.errors})`,
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

function verdictFromVotes(votes: {
  JPN: number;
  KOR: number;
  ENG: number;
}): ArtistNationalityCode {
  const jpn = votes.JPN > 0 ? 1 : 0;
  const kor = votes.KOR > 0 ? 1 : 0;
  const eng = votes.ENG > 0 ? 1 : 0;
  const distinct = jpn + kor + eng;
  if (distinct === 0) return 'UNKNOWN';
  if (distinct > 1) return 'AMBIGUOUS';
  if (jpn === 1) return 'JPN';
  if (kor === 1) return 'KOR';
  return 'ENG';
}

function logProgress(
  logger: { log(msg: string): void },
  processed: number,
  stats: EnrichArtistMapStats,
): void {
  logger.log(
    `[tj-artist] scanned ${processed}/${stats.totalArtists} — JPN=${stats.byCode.JPN} KOR=${stats.byCode.KOR} ENG=${stats.byCode.ENG} AMBIG=${stats.byCode.AMBIGUOUS} UNK=${stats.byCode.UNKNOWN} (hits=${stats.cacheHits} fetches=${stats.fetches} errors=${stats.errors})`,
  );
}
