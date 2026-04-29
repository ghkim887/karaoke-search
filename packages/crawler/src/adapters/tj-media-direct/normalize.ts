/**
 * Shared normalization helpers for the TJ-direct adapter.
 *
 * Extracted in PR-2 (the searchSong-backed nationality filter) so the cache,
 * the per-artist scanner, and the parser all hash artist names the same way.
 *
 * `normalizeForMatch` is intentionally minimal: whitespace-collapse, lowercase,
 * NFKC. The same rule that the legacy Chinese-artist denylist used. Keep it
 * stable — every cache key in `tj-search-cache.json`'s `artistNationalityMap`
 * is derived from this function. Changing the rule invalidates the on-disk
 * cache (entries simply won't be hit; not a hard failure but defeats the
 * purpose of pre-seeding).
 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
}

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
