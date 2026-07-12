import type { RawSongRecord } from '@karaoke/schema';
import type { SearchSongCache } from './cache.js';
import { FILTER_STEPS, buildFilterContext } from './filterSteps.js';
import { extractCatalogItems } from './normalize.js';
import { reviewedTjSongRender } from './reviewedSongOverrides.js';

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
 * One classified TJ catalog row (admit or drop), mirroring the JOYSOUND
 * `DecisionRecord` idea (`adapters/joysound-official/diagnostic.ts`). Emitted
 * for every row that reached the filter chain — i.e. every row that survived
 * the malformed-row guard (missing/empty tj/title/artist rows are skipped and
 * are NOT decisions). The crawler persists these as a JSONL decision log so a
 * post-crawl reader can answer "why was TJ row X dropped / which step admitted
 * it", which the 5 aggregate `KeepStats` stdout counters cannot.
 */
export interface TjFilterDecisionRecord {
  /** TJ catalog number (stable key). */
  tj: string;
  /** Raw `indexTitle` (trimmed). */
  title: string;
  /** Raw `indexSong` (trimmed) — despite the field name, this is the artist. */
  artist: string;
  decision: 'admit' | 'drop';
  /** `FilterStep.name` that fired; `null` for a no-step fall-through. */
  step: string | null;
  /**
   * admit: the via (`'artist' | 'pro' | 'song-override' | 'rescue'`).
   * reject: the firing step's reason (`'korean-drop-list' | 'chinese-drop-list'
   *   | 'pro-non-jpn' | 'reviewed-song-drop' | …`).
   * fall-through (no step fired): `'no-admit-path'` — a NEW signal separating
   *   "explicitly rejected by step X" from "no admit path claimed it".
   */
  reason: string;
}

/**
 * Result of parsing a catalog response: the kept records plus the per-path
 * admit counters. Returned as a struct (not just `RawSongRecord[]`) so the
 * crawler can log which path is admitting how many records — useful telemetry
 * for post-pre-seed audits.
 *
 * `decisions` is the per-row attribution log (one entry per classified row,
 * admit and drop alike). It is CONSISTENT with `stats` by construction: the
 * admit-`reason` tallies equal the `admittedBy*` counters and the drop count
 * equals `dropped`.
 */
export interface ParseResult {
  records: RawSongRecord[];
  stats: KeepStats;
  decisions: TjFilterDecisionRecord[];
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
  const decisions: TjFilterDecisionRecord[] = [];
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

    const { verdict, step, reason } = classifyRecordWithReason(tj, artist, cache, force);
    // One decision per classified row (admit and drop alike). Recorded with
    // the RAW trimmed artist (not the per-song render override) so the log
    // reflects the catalog input the filter actually saw.
    decisions.push({
      tj,
      title,
      artist,
      decision: verdict === 'drop' ? 'drop' : 'admit',
      step,
      reason,
    });
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

    // Per-song rendering override (reviewed-song-allow rows only): a curated
    // JP release whose catalog `indexSong` carries a Hangul gloss
    // (e.g. `IVE(아이브)`) is stamped with its script-clean display form so the
    // admitted row does not read as Korean-script leakage. Absent for every
    // other row — the raw `indexSong` is kept.
    const render = reviewedTjSongRender(tj);
    records.push({
      source_url: sourceUrl,
      title_primary: title,
      title_ko: null,
      artist_primary: render ? render.artist_primary : artist,
      artist_ko: render ? render.artist_ko : null,
      karaoke_numbers: { tj, ky: null, joysound: null },
    });
  }

  return { records, stats, decisions };
}

/**
 * Which admit path (if any) keeps this record? `'drop'` means none.
 *
 * The classifiers below (`classifyRecordWithReason` / `classifyRecord`) are
 * exported for unit tests so the filter logic can be exercised directly
 * without going through the JSON-extraction wrapper.
 *
 * Filter chain (post 2026-06 FP/FN audit) — implemented as a typed
 * FilterStep[] reducer. CLAUDE.md gotcha: the order is LOAD-BEARING; do not
 * reorder. Authoritative order: see the numbered list on FILTER_STEPS in
 * filterSteps.ts. If no step admits, drop.
 */
export type KeepVerdict = 'artist' | 'pro' | 'song-override' | 'rescue' | 'drop';

/**
 * Attribution-rich classifier. Runs the FILTER_STEPS chain exactly like
 * {@link classifyRecord} but ALSO reports which step fired and why, so
 * `parseCatalogResponse` can build the per-row decision log without a second
 * pass over the chain:
 *   - admit → `{ verdict: <via>, step: <step.name>, reason: <via> }`
 *   - reject → `{ verdict: 'drop', step: <step.name>, reason: <step reason> }`
 *   - no step fired → `{ verdict: 'drop', step: null, reason: 'no-admit-path' }`
 *
 * The `no-admit-path` reason is a NEW signal — it distinguishes an explicit
 * step reject from a silent fall-through, which the bare `'drop'` verdict
 * cannot. Pure telemetry: the returned `verdict` is identical to what
 * `classifyRecord` returns, so admit/drop behavior is unchanged.
 */
export function classifyRecordWithReason(
  tj: string,
  artist: string,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): { verdict: KeepVerdict; step: string | null; reason: string } {
  const ctx = buildFilterContext(tj, artist, cache, force);
  for (const step of FILTER_STEPS) {
    const verdict = step.evaluate(ctx);
    if (verdict.decision === 'admit') {
      return { verdict: verdict.via, step: step.name, reason: verdict.via };
    }
    if (verdict.decision === 'reject') {
      return { verdict: 'drop', step: step.name, reason: verdict.reason };
    }
    // 'pass' → continue to next step
  }
  return { verdict: 'drop', step: null, reason: 'no-admit-path' };
}

/**
 * Which admit path (if any) keeps this record? Thin wrapper over
 * {@link classifyRecordWithReason} that discards the attribution — kept so
 * existing callers/tests that only need the keep/drop verdict are unchanged.
 */
export function classifyRecord(
  tj: string,
  artist: string,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): KeepVerdict {
  return classifyRecordWithReason(tj, artist, cache, force).verdict;
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
