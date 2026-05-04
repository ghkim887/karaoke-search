import type { HttpClient } from '../../http.js';
import { coerceProString, isPlainObject, sanitizeSearchTxt } from './normalize.js';

/**
 * `/legacy/api/searchSong` HTTP helper.
 *
 * Endpoint contract (live-verified 2026-04-29 — see
 * `docs/research/2026-04-29-tj-media-api-surface.md`):
 *
 *   POST https://www.tjmedia.com/legacy/api/searchSong
 *   Content-Type: application/x-www-form-urlencoded
 *   body: searchTxt=<query>&strType=1&nationType=JPN
 *
 * Response envelope:
 *
 *   {
 *     resultCode: "99",          // success — "98" empty/no-data, "20" missing param
 *     resultMsg: "성공",
 *     resultData: <see below>,
 *     GNB_MENU: [...]            // ignored
 *   }
 *
 * Response shape (server caprice — both shapes seen in the wild):
 *  - `strType=0` (integrated) returns up to 6 buckets:
 *      `[ { itemsNTotalCount, itemsN: [...] }, ... ]`
 *  - `strType=1` (title) and `strType=2` (artist) sometimes return a flat
 *    `{ itemsTotalCount, items: [...] }` object, sometimes the same 6-bucket
 *    array structure with all but one bucket empty. We tolerate both.
 *
 * Per-item shape (rich!):
 *
 *   {
 *     rownumber, imgthumb_path, pro, indexTitle, subTitle, indexSong,
 *     word, com, sortTitleKo, sortSongKo, icongubun, mv_yn, nationalcode,
 *     publishdate
 *   }
 *
 * Rate-limit + politeness rides on the shared `HttpClient` (TJ host config:
 * 500 ms base + ±100 ms jitter). Cache-bypass POST already enforced by
 * `HttpClient.postForm`.
 *
 * Failure semantics:
 *  - throws on robots-disallow (postForm returns null)
 *  - throws on non-2xx HTTP status
 *  - throws on non-JSON body
 *  - throws on `resultCode !== "99"` AND `resultCode !== "98"` (98 = empty,
 *    treated as "no matches" and returns `[]`)
 *  - throws on malformed `resultData` shape
 *
 * Empty `searchTxt` rejected at the call-site (returns 98 from the server,
 * which we coerce to `[]` rather than throwing — same as a no-hits search).
 */

const SEARCH_SONG_URL = 'https://www.tjmedia.com/legacy/api/searchSong';

/** Allowed values for the `strType` form param. */
export type SearchSongStrType = 0 | 1 | 2;

/** Allowed values for the `nationType` form param. */
export type SearchSongNationType = '' | 'KOR' | 'ENG' | 'JPN';

/** Subset of the per-item TJ payload retained for downstream use. */
export interface SearchSongItem {
  /** TJ catalog number — primary key joining back to `newSongOfMonth`. */
  pro: string;
  /** Title in original script. */
  indexTitle: string;
  /** Subtitle (often empty). */
  subTitle: string | null;
  /** Artist in original script. */
  indexSong: string;
  /** Korean transliteration of the title (empty string from API → null). */
  sortTitleKo: string | null;
  /** Korean transliteration of the artist (empty string from API → null). */
  sortSongKo: string | null;
  /** Authoritative nationality tag. Empty/missing → null. */
  nationalcode: string | null;
  /** Publish date (`YYYY-MM-DD`). */
  publishdate: string | null;
}

/**
 * Issue a single title-search call and return the parsed item list.
 *
 * The wrapper accepts any `strType` (0/1/2) and any `nationType` for
 * future-proofing, but the primary call site passes `strType=1` (title) +
 * `nationType=JPN` to filter to Japanese titles only.
 *
 * Apostrophe handling: ASCII single quotes (`'`) are stripped from
 * `searchTxt` before sending — the TJ server's search endpoint has a parser
 * bug that returns `resultCode=04` on values containing them. See
 * `sanitizeSearchTxt` in `./normalize.ts`.
 */
export async function searchSongByTitle(
  http: Pick<HttpClient, 'postForm'>,
  searchTxt: string,
  nationType: SearchSongNationType = 'JPN',
  strType: SearchSongStrType = 1,
): Promise<SearchSongItem[]> {
  return searchSong(http, searchTxt, strType, nationType);
}

/**
 * Issue a single artist-search call (`strType=2`) and return the parsed item
 * list. Used by the per-artist nationality scanner (PR-2) to vote on each
 * artist's `nationalcode` across the catalog.
 *
 * Defaults to `nationType=''` (all nationalities) so we can collect votes
 * across JPN/KOR/ENG and classify the artist from the distribution.
 *
 * Apostrophe handling: same as `searchSongByTitle` — stripped before send.
 */
export async function searchSongByArtist(
  http: Pick<HttpClient, 'postForm'>,
  searchTxt: string,
  nationType: SearchSongNationType = '',
): Promise<SearchSongItem[]> {
  return searchSong(http, searchTxt, 2, nationType);
}

/**
 * Internal: shared transport for both title and artist searches. All inbound
 * `searchTxt` values pass through `sanitizeSearchTxt` first (apostrophe
 * strip) — the only call sites are the two helpers above, so centralizing
 * the sanitization here is the simplest "one rule, one place" surface.
 */
async function searchSong(
  http: Pick<HttpClient, 'postForm'>,
  searchTxt: string,
  strType: SearchSongStrType,
  nationType: SearchSongNationType,
): Promise<SearchSongItem[]> {
  if (typeof searchTxt !== 'string') return [];
  const cleaned = sanitizeSearchTxt(searchTxt);
  if (cleaned === '') {
    // Server returns code 98 on empty searchTxt; short-circuit to avoid the
    // round-trip and return the same empty-list semantics. Also covers the
    // edge case where the input was a single apostrophe that sanitization
    // stripped to ''.
    return [];
  }

  const res = await http.postForm(SEARCH_SONG_URL, {
    searchTxt: cleaned,
    strType: String(strType),
    nationType,
  });

  if (res === null) {
    throw new Error(`[tj-search] searchSong blocked by robots.txt: ${SEARCH_SONG_URL}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`[tj-search] searchSong returned HTTP ${res.status} (${SEARCH_SONG_URL})`);
  }

  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[tj-search] searchSong response is not valid JSON: ${msg}`);
  }

  return parseSearchSongResponse(json);
}

/**
 * Parse a `/legacy/api/searchSong` response envelope into a flat item list.
 *
 * Exported for unit tests; in production code prefer `searchSongByTitle`
 * which also handles HTTP transport.
 */
export function parseSearchSongResponse(json: unknown): SearchSongItem[] {
  if (!isPlainObject(json)) {
    throw new Error('[tj-search] response is not a JSON object');
  }
  const code = json.resultCode;
  if (code === '98') {
    // Documented "empty/no-data" code. Same semantics as zero results.
    return [];
  }
  if (code !== '99') {
    const msg = typeof json.resultMsg === 'string' ? json.resultMsg : '<no message>';
    throw new Error(`[tj-search] resultCode=${String(code)} (${msg})`);
  }

  const data = json.resultData;
  const rawItems: unknown[] = collectItems(data);
  const out: SearchSongItem[] = [];
  for (const raw of rawItems) {
    const item = mapItem(raw);
    if (item !== null) out.push(item);
  }
  return out;
}

/**
 * Pull the per-item objects out of a `resultData` payload, tolerating both
 * the flat `{ itemsTotalCount, items }` shape and the 6-bucket array shape.
 *
 * Failure-mode contract: this helper THROWS on an unrecognized response shape.
 * That intentionally diverges from `bootstrapCharts.ts:parseChartResponse`,
 * which TOLERATES weird shapes and returns `[]`. The rationale is that the
 * `searchSong` endpoint is the authoritative source for nationalcode + translit
 * — every caller depends on the result, so failing loud is correct (a silent
 * `[]` would let a per-artist scan classify a real Japanese act as UNKNOWN
 * just because TJ briefly served a malformed envelope, which would persist in
 * the cache for 90 days). The chart endpoint is best-effort signal only;
 * skipping a borked window costs us a few JPN votes and self-heals next sweep.
 * Do not unify these two helpers without preserving the divergent semantics.
 */
function collectItems(data: unknown): unknown[] {
  if (data === null || data === undefined) return [];

  // Flat shape: { itemsTotalCount, items: [...] }
  if (isPlainObject(data) && Array.isArray(data.items)) {
    return data.items;
  }

  // 6-bucket array shape: [{ items1TotalCount, items1: [...] }, { items2: ... }, ...]
  if (Array.isArray(data)) {
    const merged: unknown[] = [];
    for (const bucket of data) {
      if (!isPlainObject(bucket)) continue;
      // Each bucket has one items<N> array; inspect every key to find it.
      for (const key of Object.keys(bucket)) {
        if (!key.startsWith('items')) continue;
        if (key.endsWith('TotalCount')) continue;
        const value = bucket[key];
        if (Array.isArray(value)) {
          merged.push(...value);
        }
      }
    }
    return merged;
  }

  // Some empty responses are `resultData: ""` or absent entirely.
  if (typeof data === 'string') return [];

  throw new Error('[tj-search] resultData has unexpected shape');
}

function mapItem(raw: unknown): SearchSongItem | null {
  if (!isPlainObject(raw)) return null;

  const pro = coerceProString(raw.pro);
  // `indexTitle` and `indexSong` are required identifiers — empty strings are
  // treated as missing (the catalog occasionally returns rows with one of
  // these blank that are unusable downstream).
  const indexTitle = emptyToNull(coerceString(raw.indexTitle));
  const indexSong = emptyToNull(coerceString(raw.indexSong));
  if (pro === null || indexTitle === null || indexSong === null) return null;

  return {
    pro,
    indexTitle,
    indexSong,
    subTitle: emptyToNull(coerceString(raw.subTitle)),
    sortTitleKo: emptyToNull(coerceString(raw.sortTitleKo)),
    sortSongKo: emptyToNull(coerceString(raw.sortSongKo)),
    nationalcode: emptyToNull(coerceString(raw.nationalcode)),
    publishdate: emptyToNull(coerceString(raw.publishdate)),
  };
}

function coerceString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  return null;
}

function emptyToNull(v: string | null): string | null {
  if (v === null) return null;
  if (v === '') return null;
  return v;
}
