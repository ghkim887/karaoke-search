import type { RawSongRecord } from '@karaoke/schema';
import type { SearchSongCache } from './cache.js';
import { FILTER_STEPS, buildFilterContext } from './filterSteps.js';
import { isPlainObject } from './normalize.js';

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
 * Three independent admit signals; first to confirm JPN keeps the record.
 * None say JPN -> drop. The reading order below is primary -> secondary ->
 * safety net; the behavior is "any-admit", so reordering does not change
 * which records are kept, only which path gets credit in `KeepStats`.
 *
 *   1. **Per-artist JPN tag (primary).** Split `artist` via
 *      `splitArtistCollab` (whole-string scan PLUS per-component scan for
 *      collab strings like `imase & なとり`, `IDOLiSH7,TRIGGER,Re:vale`,
 *      `Charlie Puth(Feat.宇多田ヒカル)`, …). If ANY component has
 *      `cache.artistNationalityMap[normalize(component)].code === 'JPN'`,
 *      keep. This is the primary path because per-record title-search has
 *      empirically high miss rates (33% in PR-1's pre-seed: 1,950 / 5,961
 *      title-search calls returned no `pro` match). Per-artist scanning
 *      uses `searchSong?strType=2` (artist field) which side-steps that gap
 *      — and crucially admits Latin-titled Japanese acts (GRANRODEO,
 *      halyosy, fripSide etc.) where title-search returns nothing.
 *
 *   2. **Per-record JPN tag (backup).** If
 *      `cache.proEnrichmentMap[pro].nationalcode === 'JPN'`, keep. Populated
 *      by the translit pass's `searchSong?strType=1` exact-`pro`-match. This
 *      catches the case where the artist scan classified an artist as
 *      AMBIGUOUS (mixed JPN/KOR votes) but the specific `pro` is JPN.
 *
 *   3. **Blog-whitelist rescue (safety net).** If `pro` is in
 *      `forceIncludeTjNumbers`, keep. The blog adapter has been hand-
 *      validated for 21k+ Japanese records over time, so a TJ# the blog
 *      already knows about is JPN. Defense-in-depth for residual TJ-search
 *      index gaps neither searchSong path could see.
 *
 * Otherwise, the record is **dropped** — Korean, English, Chinese, Mandopop,
 * any artist `searchSong` hasn't confirmed JPN.
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
 *   - `admittedByPro`: path 2 (per-record JPN tag) admitted first.
 *   - `admittedByRescue`: path 3 (blog whitelist) admitted first.
 *   - `dropped`: no path confirmed JPN.
 *
 * "First to fire wins" — the counters reflect the reading order, not how
 * many paths would have admitted. A record admitted by paths 1 AND 2 is
 * counted only as `admittedByArtist`.
 */
export interface KeepStats {
  admittedByArtist: number;
  admittedByPro: number;
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
  const items = extractItems(json);
  const records: RawSongRecord[] = [];
  const force = options.forceIncludeTjNumbers;
  const cache = options.cache;

  const stats: KeepStats = {
    admittedByArtist: 0,
    admittedByPro: 0,
    admittedByRescue: 0,
    dropped: 0,
  };

  for (const item of items) {
    if (!isPlainObject(item)) continue;
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
      categories: ['jpop'],
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
 * Filter chain order (post Phase 1 KPOP-leak fix, spec §2.E) — implemented
 * as a typed FilterStep[] reducer in filterSteps.ts. CLAUDE.md gotcha: this
 * order is LOAD-BEARING; do not reorder FILTER_STEPS.
 *   0. drop-list-reject  — drop-list check, any-component (§2.E)
 *   1. kor-reject        — per-pro KOR-reject (§2.C)
 *   2. jpn-admit-artist  — per-artist JPN tag, lead-component-only (§2.B)
 *   3. jpn-admit-pro     — per-pro JPN tag
 *   4. blog-rescue       — blog-whitelist rescue (safety net, NOT dead code)
 *
 * If no step admits, drop.
 */
export type KeepVerdict = 'artist' | 'pro' | 'rescue' | 'drop';

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

/**
 * Boolean wrapper kept for callers that just want a yes/no verdict. The
 * production parser uses `classifyRecord` directly so it can record per-path
 * admit counters.
 *
 * Exported for unit tests written before `classifyRecord` was split out.
 */
export function shouldKeep(
  tj: string,
  artist: string,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): boolean {
  return classifyRecord(tj, artist, cache, force) !== 'drop';
}

function extractItems(json: unknown): unknown[] {
  // Note: the live API returns `resultCode: "99"` for successful catalog
  // responses (not "00" as one might expect). We do not check `resultCode` —
  // only that `resultData.items` is an array.
  if (!isPlainObject(json)) {
    throw new Error('tj-media-direct parser: response is not a JSON object');
  }
  const data = json.resultData;
  if (!isPlainObject(data)) {
    throw new Error('tj-media-direct parser: response.resultData missing or not an object');
  }
  const items = data.items;
  if (!Array.isArray(items)) {
    throw new Error('tj-media-direct parser: response.resultData.items is not an array');
  }
  return items;
}
