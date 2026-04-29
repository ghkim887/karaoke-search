import type { RawSongRecord } from '@karaoke/schema';
import type { HttpClient } from '../../http.js';
import { type EnrichmentEntry, type SearchSongCache, isFresh } from './cache.js';
import { type SearchSongItem, searchSongByTitle } from './searchSong.js';

/**
 * Per-record translit enrichment pass.
 *
 * For each input record (already filtered to JPN by the existing parser),
 * this pass attempts to populate `title_ko` and `artist_ko` from TJ's
 * `/legacy/api/searchSong` response.
 *
 * Algorithm per record:
 *   1. If `proEnrichmentMap[pro]` is fresh (`lastSeen` within 90 days):
 *      reuse it (cache hit).
 *   2. Else: call `searchSongByTitle(http, record.title_primary, 'JPN')`,
 *      find the result whose `pro` matches the record's `pro`, store and
 *      return that entry (fetch).
 *   3. On HTTP error or `pro` mismatch (TJ returned different songs):
 *      log a warning and continue — the record's `title_ko`/`artist_ko`
 *      stay null. Same as today, no regression.
 *
 * Logs progress every 500 records:
 *   `[tj-search] enriched N/total — cache hits H, fetches F, misses M`
 *
 * Returns a `Map<pro, EnrichmentEntry>` keyed by the TJ catalog number,
 * for the caller (the crawler) to thread into `normalize()`. The cache
 * argument is mutated in place (entries added under their `pro` key);
 * the caller is responsible for calling `saveCache(...)` at the end.
 */

export interface EnrichTranslitOptions {
  /** Override the date used for staleness checks. Tests inject a frozen now. */
  now?: Date;
  /** Override the per-N-records progress log cadence. Default 500. */
  progressEveryN?: number;
  /** Override the console used for log/warn output. Tests inject a recorder. */
  logger?: { log(msg: string): void; warn(msg: string): void };
}

export interface EnrichTranslitStats {
  total: number;
  cacheHits: number;
  fetches: number;
  /** Records where searchSong returned no `pro` match (TJ index miss). */
  misses: number;
  /** Records where the searchSong call threw (HTTP error etc.). */
  errors: number;
}

export interface EnrichTranslitResult {
  /** Per-`pro` enrichment lookup; mirrors the cache for the records seen. */
  byPro: Map<string, EnrichmentEntry>;
  stats: EnrichTranslitStats;
}

export async function enrichWithTranslit(
  http: Pick<HttpClient, 'postForm'>,
  records: ReadonlyArray<RawSongRecord>,
  cache: SearchSongCache,
  options: EnrichTranslitOptions = {},
): Promise<EnrichTranslitResult> {
  const now = options.now ?? new Date();
  const progressEveryN = options.progressEveryN ?? 500;
  const logger = options.logger ?? {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };

  const byPro = new Map<string, EnrichmentEntry>();
  const stats: EnrichTranslitStats = {
    total: records.length,
    cacheHits: 0,
    fetches: 0,
    misses: 0,
    errors: 0,
  };

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const pro = record.karaoke_numbers.tj;
    if (pro === null) continue;

    // Cache hit fast path.
    if (isFresh(cache, pro, now)) {
      const entry = cache.proEnrichmentMap[pro];
      if (entry) {
        byPro.set(pro, entry);
        stats.cacheHits++;
      }
    } else {
      let items: SearchSongItem[] = [];
      let fetchSucceeded = false;
      try {
        items = await searchSongByTitle(http, record.title_primary, 'JPN');
        stats.fetches++;
        fetchSucceeded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          `[tj-search] enrichment fetch failed for pro=${pro} (title="${record.title_primary}"): ${msg}`,
        );
        stats.errors++;
      }

      const match = items.find((item) => item.pro === pro);
      if (match) {
        const entry: EnrichmentEntry = {
          nationalcode: match.nationalcode,
          sortTitleKo: match.sortTitleKo,
          sortSongKo: match.sortSongKo,
          subTitle: match.subTitle,
          publishdate: match.publishdate,
          lastSeen: now.toISOString(),
        };
        cache.proEnrichmentMap[pro] = entry;
        byPro.set(pro, entry);
      } else if (fetchSucceeded) {
        // TJ index miss: searchSong did not return our `pro`. Could be because
        // TJ search uses a different title-normalization rule than the catalog
        // API exposes, or the title is too short for the search index. We
        // continue; downstream `title_ko`/`artist_ko` stay null for this record.
        // Only counted as a miss when the fetch actually succeeded — transport
        // errors are accounted to `stats.errors` above and must NOT also bump
        // `stats.misses` (was a double-count bug pre-fix).
        stats.misses++;
      }
    }

    if (progressEveryN > 0 && (i + 1) % progressEveryN === 0) {
      logger.log(
        `[tj-search] enriched ${i + 1}/${stats.total} — cache hits ${stats.cacheHits}, fetches ${stats.fetches}, misses ${stats.misses}`,
      );
    }
  }

  // Final progress line (so the operator sees the total even when total is
  // not a multiple of progressEveryN).
  logger.log(
    `[tj-search] enriched ${stats.total}/${stats.total} — cache hits ${stats.cacheHits}, fetches ${stats.fetches}, misses ${stats.misses}, errors ${stats.errors}`,
  );

  // Refresh `generatedAt` on the cache when we mutated anything; the caller
  // saves the file post-enrichment.
  if (stats.fetches > 0) {
    cache.generatedAt = now.toISOString();
  }

  return { byPro, stats };
}
