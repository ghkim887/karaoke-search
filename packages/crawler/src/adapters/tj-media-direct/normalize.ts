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

/**
 * Split a multi-artist collab string into component artist names.
 *
 * Splits on common delimiters: `&`, `＆`, `,`, `×`, ` with `, `feat.` (any
 * case), and parenthetical chunks that contain `(Feat. ...)` / `(feat. ...)`
 * etc. in any position. The slash and bracket-style collab forms
 * (`Artist1/Artist2`, `Artist1[ft.Artist2]`) are intentionally NOT split —
 * neither pattern is observed in the live TJ catalog and both have a high
 * false-positive risk (e.g. `AC/DC`, `[Alexandros]`).
 *
 * Always returns the ORIGINAL trimmed string as the first element so single-
 * artist names round-trip unchanged AND the existing per-record cache path
 * (which uses the whole artist as key) keeps hitting the same entries.
 *
 * Components are deduplicated by `normalizeForMatch` — two surface forms that
 * collapse to the same key produce a single component. Empty parts are
 * dropped. An empty / whitespace-only input yields `[]`.
 *
 * Examples:
 *   'imase & なとり' -> ['imase & なとり', 'imase', 'なとり']
 *   'imase ＆ なとり' -> ['imase ＆ なとり', 'imase', 'なとり']
 *   'IDOLiSH7,TRIGGER,Re:vale' -> ['IDOLiSH7,TRIGGER,Re:vale', 'IDOLiSH7', 'TRIGGER', 'Re:vale']
 *   'Charlie Puth(Feat.宇多田ヒカル)' -> ['Charlie Puth(Feat.宇多田ヒカル)', 'Charlie Puth', '宇多田ヒカル']
 *   'Charlie Puth(Feat.宇多田ヒカル) & Adele' -> ['Charlie Puth(Feat.宇多田ヒカル) & Adele', 'Charlie Puth', 'Adele', '宇多田ヒカル']
 *   '安室奈美恵 with スーパーモンキーズ' -> ['安室奈美恵 with スーパーモンキーズ', '安室奈美恵', 'スーパーモンキーズ']
 *   'Artist1 × Artist2' -> ['Artist1 × Artist2', 'Artist1', 'Artist2']
 *   'YOASOBI' -> ['YOASOBI']
 *   '' -> []
 */
export function splitArtistCollab(artist: string): string[] {
  const whole = artist.trim();
  if (whole === '') return [];

  // Collect raw parts before dedupe. The whole string is always parts[0]
  // so single-artist names short-circuit on the leading entry and the
  // existing per-record cache path keeps hitting the same key.
  const parts: string[] = [whole];

  // Global pre-pass: extract every `(Feat. X)` / `(FEAT. X)` parenthetical
  // from anywhere in the string (not just trailing). Each matched block is
  // replaced with a single space (collapsed by later trim) and its inner
  // content is captured for appending after the primary split. This handles
  // mid-string parentheticals like `Charlie Puth(Feat.宇多田ヒカル) & Adele`
  // that the old anchored-at-$ approach missed.
  const FEAT_PAREN_RE = /\s*\(\s*feat\.\s*([^()]+?)\s*\)\s*/gi;
  const featContents: string[] = [];
  let main = whole.replace(FEAT_PAREN_RE, (_, inner: string) => {
    featContents.push(inner);
    return ' ';
  });
  main = main.trim();

  // Split the remaining string on the primary delimiters (case-insensitive
  // flag `i` covers FEAT. / With / WITH). The regex matches:
  //   - `&` / `＆` (U+FF06 full-width — split runs before NFKC normalisation)
  //     / `,` / `×` with optional surrounding whitespace
  //   - ` with ` (whitespace-delimited so it never bites mid-word)
  //   - `feat.` (any case) with optional surrounding whitespace (catches the
  //     un-parenthesized form like `Artist1 FEAT. Artist2`)
  const SPLIT_RE = /\s*[&＆,×]\s*|\s+with\s+|\s*feat\.\s*/i;
  if (main !== '') {
    for (const piece of main.split(SPLIT_RE)) {
      const trimmed = piece.trim();
      if (trimmed !== '') parts.push(trimmed);
    }
  }

  // Append the featured-artist content AFTER the lead split so output reads
  // lead-first, featured-last (matches the natural collab reading order).
  for (const fc of featContents) {
    if (fc !== '') parts.push(fc);
  }

  // Dedupe by `normalizeForMatch` while preserving first-seen order. The whole
  // string is always parts[0] so it survives dedupe; components that re-derive
  // the same key (e.g. a single-artist input where split returns the whole
  // string again) collapse into the leading entry.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const key = normalizeForMatch(part);
    if (key === '') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out;
}
