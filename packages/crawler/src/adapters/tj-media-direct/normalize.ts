/**
 * TJ-direct adapter normalization helpers.
 *
 * Cross-adapter clustering primitives (`normalizeForMatch`, `splitArtistCollab`,
 * `getLeadComponent`) used to live here but were moved to `../../clustering.ts`
 * in the 2026-05-06 refactor — the central merger should not depend on a
 * specific adapter's normalize module. The re-exports at the bottom of this
 * file keep the existing in-adapter import paths working without forcing every
 * call site to retarget `../../clustering.js` in the same PR.
 *
 * What stays here: TJ-server-quirk helpers (`sanitizeSearchTxt`),
 * blog-whitelist script-detection regexes (`RE_HIRAGANA`, `RE_KATAKANA`,
 * `RE_HAN`, `RE_HANGUL`), and the JSON-shape coercion helpers shared across
 * the TJ-direct modules (`isPlainObject`, `coerceProString`).
 */
export {
  SPLIT_RE,
  getLeadComponent,
  normalizeForMatch,
  splitArtistCollab,
} from '../../clustering.js';

/**
 * Script-detection regexes used by the blog-whitelist trim (PR-3).
 *
 * The blog-rescue path (`defaultBlogWhitelistSource`) historically admitted
 * every TJ# present in the blog corpus. An audit found that ~88% of the
 * rescued records were Mandopop / Cantopop / K-pop entries mistakenly carried
 * with `categories: ['jpop']`. The signal that exposes them is artist-name
 * script: pure-Han (Chinese) or pure-Hangul (Korean) artist strings with no
 * kana are almost never genuine JP acts.
 *
 * Ranges match the BMP blocks for Hiragana, Katakana, Han ideographs (CJK
 * Unified Ideographs main block), and Hangul syllables. They are intentionally
 * narrow — the blog-whitelist filter only needs a yes/no script signal, not a
 * full Unicode character classification.
 */
export const RE_HIRAGANA = /[぀-ゟ]/;
export const RE_KATAKANA = /[゠-ヿ]/;
export const RE_HAN = /[一-鿿]/;
export const RE_HANGUL = /[가-힣]/;

/**
 * Sanitize a `searchTxt` value before sending it to `/legacy/api/searchSong`.
 *
 * The TJ server's search endpoint has a parser bug on titles or artist names
 * containing single ASCII apostrophes (`'`): the server returns
 * `resultCode=04 / 알수 없는 에러` instead of `99/98`, which the parser then
 * surfaces as a thrown error. Affected ≥2 records observed during the PR-1
 * pre-seed (`pro=68988`, `pro=68992` — IDOLiSH7 OST tracks).
 *
 * We strip the apostrophe rather than escape it. Escape attempts (`\'`,
 * `%27`, double-quoting) all hit the same bug; the server only tolerates the
 * value when the character is absent. This is consistent with how the public
 * search HTML form behaves — typing `Don't` matches `Dont` results too. The
 * worst case is a slightly broader fuzzy match; the alternative is a
 * pipeline-aborting throw.
 *
 * Other characters (Japanese punctuation, parentheses, em-dash, etc.) appear
 * to round-trip fine and are NOT sanitized here — narrow, surgical fix.
 */
export function sanitizeSearchTxt(s: string): string {
  return s.replace(/'/g, '');
}

/**
 * Narrow type-guard for plain JSON objects (i.e. `Record<string, unknown>` and
 * not an array). Centralised here in PR (cleanup wave) so the TJ-direct
 * adapter modules (`parser.ts`, `searchSong.ts`, `cache.ts`, `crawler.ts`,
 * `bootstrapCharts.ts`) all share a single definition rather than each
 * declaring an identical local copy.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coerce a JSON value into a non-empty trimmed string suitable for use as a
 * TJ `pro` (program) identifier. Numbers are stringified (finite-only) and
 * strings are trimmed; anything else (or empty/whitespace) returns `null`.
 *
 * Centralised here so `searchSong.ts` and `bootstrapCharts.ts` share one
 * definition (both consume the same TJ JSON shape; the original duplicates
 * were byte-identical).
 */
export function coerceProString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

/**
 * Coerce a JSON value into a non-empty string. Returns `null` for anything
 * that is not a string, and for strings that are empty (or — when `trim` is
 * `true` — whitespace-only).
 *
 * `searchSong.ts` calls this with `{ trim: false }` to preserve untrimmed
 * `indexTitle` / `indexSong` content (the TJ payload occasionally pads these
 * values with intentional internal whitespace we must round-trip verbatim
 * downstream). `bootstrapCharts.ts` uses the default `{ trim: true }` because
 * chart items are display-bound and benefit from whitespace normalization.
 *
 * Centralised here so both `searchSong.ts` and `bootstrapCharts.ts` share one
 * definition for the empty-string coercion they both performed locally.
 */
export function coerceNonEmptyString(
  v: unknown,
  opts: { trim?: boolean } = { trim: true },
): string | null {
  if (typeof v !== 'string') return null;
  const s = opts.trim ? v.trim() : v;
  return s === '' ? null : s;
}

/**
 * Pull the per-item objects out of a `resultData` payload, tolerating both
 * the flat `{ itemsTotalCount, items }` shape and the 6-bucket array shape
 * (`[{ items1TotalCount, items1: [...] }, { items2: ... }, ...]`).
 *
 * Failure-mode contract is selectable via `opts.onUnknownShape`:
 *  - `'throw'`: throws on a completely unrecognized envelope. Used by
 *    `searchSong.ts` because the endpoint is the authoritative source for
 *    nationalcode + translit — a silent `[]` could persist a wrong verdict in
 *    the 90-day cache.
 *  - `'tolerate'`: returns `[]` on unrecognized shape. Used by
 *    `bootstrapCharts.ts` because the chart endpoint is best-effort signal —
 *    losing one window's votes self-heals on the next sweep.
 *
 * Do not collapse these two semantics without also revisiting the cache /
 * audit consequences — see the historical docblocks on `collectItems` in
 * both files for the reasoning trail.
 */
export function collectTjItems(
  data: unknown,
  opts: { onUnknownShape: 'throw' | 'tolerate'; errorPrefix?: string },
): Record<string, unknown>[] {
  if (data === null || data === undefined) return [];

  // Flat shape: { itemsTotalCount, items: [...] }
  if (isPlainObject(data) && Array.isArray(data.items)) {
    return data.items.filter(isPlainObject);
  }

  // 6-bucket array shape: [{ items1TotalCount, items1: [...] }, ...]
  if (Array.isArray(data)) {
    const merged: Record<string, unknown>[] = [];
    for (const bucket of data) {
      if (!isPlainObject(bucket)) continue;
      for (const key of Object.keys(bucket)) {
        if (!key.startsWith('items')) continue;
        if (key.endsWith('TotalCount')) continue;
        const value = bucket[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isPlainObject(item)) merged.push(item);
          }
        }
      }
    }
    return merged;
  }

  // Some empty responses are `resultData: ""` or absent entirely.
  if (typeof data === 'string') return [];

  if (opts.onUnknownShape === 'throw') {
    const prefix = opts.errorPrefix ? `${opts.errorPrefix} ` : '';
    throw new Error(`${prefix}resultData has unexpected shape`);
  }
  return [];
}

/**
 * Pull the items array out of a TJ catalog response envelope. Pre-filters
 * via `isPlainObject` so callers can iterate without re-validating each
 * entry's shape.
 *
 * Throws on malformed envelope shapes — `crawler.ts` and `parser.ts` both
 * surface identical error semantics so the pipeline aborts deterministically
 * on a server-side schema change. The `label` is woven into each error
 * message so call-site provenance is preserved in logs.
 */
export function extractCatalogItems(json: unknown, label?: string): Record<string, unknown>[] {
  const prefix = label ? `${label}: ` : '';
  if (!isPlainObject(json)) {
    throw new Error(`${prefix}response is not a JSON object`);
  }
  const data = json.resultData;
  if (!isPlainObject(data)) {
    throw new Error(`${prefix}response.resultData missing or not an object`);
  }
  const items = data.items;
  if (!Array.isArray(items)) {
    throw new Error(`${prefix}response.resultData.items is not an array`);
  }
  return items.filter(isPlainObject);
}
