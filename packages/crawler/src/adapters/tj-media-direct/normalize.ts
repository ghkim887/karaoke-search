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
