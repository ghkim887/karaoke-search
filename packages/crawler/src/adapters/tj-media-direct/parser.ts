import type { RawSongRecord } from '@karaoke/schema';
import type { SearchSongCache } from './cache.js';
import { FILTER_STEPS, buildFilterContext } from './filterSteps.js';
import { extractCatalogItems } from './normalize.js';

/**
 * Parse a TJ Media catalog JSON response into `RawSongRecord`s.
 *
 * Endpoint contract (live-verified 2026-04-27):
 *   POST https://www.tjmedia.com/legacy/api/newSongOfMonth
 *   body: searchYm=200001 (form-urlencoded; "all songs since 2000-01")
 *   response: `{ resultCode, resultData: { itemsTotalCount, items: [...] }, GNB_MENU, resultMsg }`
 *
 * Each `items[i]` entry has the live shape:
 *   { rownumber, thumbnailImg, pro, indexTitle, indexSong,
 *     word, com, icongubun, mv_yn, publishdate }
 *
 * Field mapping:
 *   pro          -> karaoke_numbers.tj (cast to string)
 *   indexTitle   -> title_primary
 *   indexSong    -> artist_primary  (despite the field name, this is the artist)
 *
 * --- PR-2 filter chain (replaced the legacy JP-regex + Chinese denylist) ---
 *
 * Classification is a typed FilterStep[] reducer. The ORDER IS LOAD-BEARING;
 * authoritative order: see the numbered list on FILTER_STEPS in
 * filterSteps.ts (per-step rationale lives on each step's docblock there).
 * Reordering can change which records are kept, not just which path gets
 * credit in `KeepStats`.
 *
 * A record no step admits is **dropped** — Korean, English, Chinese,
 * Mandopop, any artist `searchSong` hasn't confirmed JPN.
 *
 * `KeepStats` (returned alongside the records) tallies which path admitted
 * each kept record (first-to-fire wins). The crawler logs these so we can
 * post-pre-seed evaluate: a high `admittedByRescue` count means the
 * searchSong index is missing real JPN records and the rescue is hiding
 * gaps; a low count means the rescue is doing minimal safety-net work.
 *
 * Items missing/empty `pro`, `indexTitle`, or `indexSong` are skipped
 * (unchanged from the legacy behavior).
 *
 * Throws if `json` does not have the expected response shape; the pipeline
 * aborts on this error (single request — there is no retry path).
 */
export interface ParseOptions {
  /**
   * The persistent searchSong cache (shared with the translit pass).
   * Required: PR-2's filter is cache-driven. Tests can pass an empty cache
   * (`emptyCache()`) to fall through to the rescue path or drop entirely.
   */
  cache: SearchSongCache;
  /**
   * Set of TJ catalog numbers (`pro`, stringified) that should bypass the
   * cache filter — typically TJ numbers already in the blog corpus. The
   * adapter passes the same set the rescue path used pre-PR-2; here it is
   * the safety net for residual TJ-search index gaps.
   */
  forceIncludeTjNumbers?: ReadonlySet<string>;
}

/**
 * Per-path admit counters. Reported alongside the parsed records so the
 * crawler can surface which path is doing the work post-pre-seed.
 *   - `admittedByArtist`: path 1 (per-artist JPN tag) admitted first.
 *   - `admittedByPro`: exact per-record JPN tag admitted first.
 *   - `admittedBySongOverride`: reviewed TJ-number song-level allow admitted first.
 *   - `admittedByRescue`: blog whitelist admitted first.
 *   - `dropped`: no path confirmed JPN.
 *
 * "First to fire wins" — the counters reflect the reading order, not how
 * many paths would have admitted. A record admitted by paths 1 AND 2 is
 * counted only as `admittedByArtist`.
 */
interface KeepStats {
  admittedByArtist: number;
  admittedByPro: number;
  admittedBySongOverride: number;
  admittedByRescue: number;
  dropped: number;
}

/**
 * Result of parsing a catalog response: the kept records plus the per-path
 * admit counters. Returned as a struct (not just `RawSongRecord[]`) so the
 * crawler can log which path is admitting how many records — useful telemetry
 * for post-pre-seed audits.
 */
export interface ParseResult {
  records: RawSongRecord[];
  stats: KeepStats;
}

export function parseCatalogResponse(
  json: unknown,
  sourceUrl: string,
  options: ParseOptions,
): ParseResult {
  // Shared envelope walker (in normalize.ts) — pre-filters non-object items
  // via `isPlainObject` so the per-item loop can drop its own guard.
  const items = extractCatalogItems(json, 'tj-media-direct parser');
  const records: RawSongRecord[] = [];
  const force = options.forceIncludeTjNumbers;
  const cache = options.cache;

  const stats: KeepStats = {
    admittedByArtist: 0,
    admittedByPro: 0,
    admittedBySongOverride: 0,
    admittedByRescue: 0,
    dropped: 0,
  };

  for (const item of items) {
    const proRaw = item.pro;
    const title = typeof item.indexTitle === 'string' ? item.indexTitle.trim() : '';
    const artist = typeof item.indexSong === 'string' ? item.indexSong.trim() : '';

    let tj: string | null = null;
    if (typeof proRaw === 'number' && Number.isFinite(proRaw)) {
      tj = String(proRaw);
    } else if (typeof proRaw === 'string' && proRaw.trim() !== '') {
      tj = proRaw.trim();
    }

    if (!tj || !title || !artist) continue;

    const verdict = classifyRecord(tj, artist, cache, force);
    switch (verdict) {
      case 'artist':
        stats.admittedByArtist++;
        break;
      case 'pro':
        stats.admittedByPro++;
        break;
      case 'song-override':
        stats.admittedBySongOverride++;
        break;
      case 'rescue':
        stats.admittedByRescue++;
        break;
      case 'drop':
        stats.dropped++;
        continue;
    }

    records.push({
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: artist,
      artist_ko: null,
      karaoke_numbers: { tj, ky: null, joysound: null },
    });
  }

  return { records, stats };
}

/**
 * Which admit path (if any) keeps this record? `'drop'` means none.
 *
 * Exported for unit tests so we can exercise the filter logic directly
 * without going through the JSON-extraction wrapper.
 *
 * Filter chain (post 2026-06 FP/FN audit) — implemented as a typed
 * FilterStep[] reducer. CLAUDE.md gotcha: the order is LOAD-BEARING; do not
 * reorder. Authoritative order: see the numbered list on FILTER_STEPS in
 * filterSteps.ts. If no step admits, drop.
 */
export type KeepVerdict = 'artist' | 'pro' | 'song-override' | 'rescue' | 'drop';

export function classifyRecord(
  tj: string,
  artist: string,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): KeepVerdict {
  const ctx = buildFilterContext(tj, artist, cache, force);
  for (const step of FILTER_STEPS) {
    const verdict = step.evaluate(ctx);
    if (verdict.decision === 'admit') return verdict.via;
    if (verdict.decision === 'reject') return 'drop';
    // 'pass' → continue to next step
  }
  return 'drop';
}

// `shouldKeep` was removed in the cleanup wave — call sites use
// `classifyRecord(...) !== 'drop'` directly. The thin boolean wrapper had no
// production caller (the parser uses `classifyRecord` directly so it can
// record per-path admit counters) and only existed for tests written before
// `classifyRecord` was split out.

// Note on response shape: the live API returns `resultCode: "99"` for
// successful catalog responses (not "00" as one might expect). We do not check
// `resultCode` — `extractCatalogItems` (in normalize.ts) only validates that
// `resultData.items` is an array.
