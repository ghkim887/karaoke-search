/**
 * Cross-adapter clustering primitives.
 *
 * Scope (in): low-level helpers used by the central merger's Tier C clustering
 * key AND by adapter-level admit/dedup logic that needs to agree with the
 * merger about what "the same artist" looks like. The whole point of this
 * module is to be ADAPTER-AGNOSTIC: nothing here may depend on a specific
 * adapter's directory, fixture, or vendor quirk. Anything that imports from
 * `./adapters/<x>/...` does NOT belong here.
 *
 * Scope (out): adapter-specific normalization (TJ catalog `pro` coercion, TJ
 * search apostrophe sanitizer, blog-whitelist script-detection regexes, etc.)
 * stays under `adapters/<x>/normalize.ts` where it can evolve with the vendor's
 * quirks without rippling through the merger.
 *
 * Why split out (Fix, refactor 2026-05-06): pre-refactor, `merge.ts` imported
 * `getLeadComponent` from `adapters/tj-media-direct/normalize.ts`. That was
 * upside-down: the central merger should not depend on any specific adapter.
 * A future adapter wanting the same Tier C clustering would have either
 * created a circular dep or duplicated the helper. This module is the shared
 * home for the helper; `adapters/tj-media-direct/normalize.ts` keeps a thin
 * re-export bridge so existing adapter-internal call sites keep working.
 */

/**
 * Whitespace-collapse + lowercase + NFKC. Stable across the codebase: every
 * cache key in `tj-search-cache.json`'s `artistNationalityMap` is derived
 * from this function. Changing the rule invalidates on-disk caches.
 *
 * Used by both the merger's Tier C clustering and adapter-level dedup.
 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase().normalize('NFKC');
}

/**
 * Module-scope regexes for `splitArtistCollab`. Hoisted out of the function
 * body so they aren't recompiled on every call. Safe to share because none
 * carry per-call state: `FEAT_PAREN_RE` is `/g` but is consumed via
 * `.replace(re, fn)` which iterates the match list internally without leaking
 * `lastIndex` across calls; `SPLIT_RE` and `OF_RE` are non-`/g` and are used
 * with `.split` / `.test` which don't touch `lastIndex` either.
 *
 * Behaviour notes:
 *
 *  - `FEAT_PAREN_RE` extracts every `(Feat. X)` / `(FEAT. X)` / `(Prod. X)`
 *    parenthetical from anywhere in the string (not just trailing). Mid-string
 *    cases like `Charlie Puth(Feat.宇多田ヒカル) & Adele` are handled, and
 *    `(Prod.X)` producer-credit syntax used by TJ (`LE SSERAFIM(Prod.imase)`)
 *    is structurally identical to `(Feat.X)` — the producer is a collab
 *    component for nationality-tag purposes.
 *
 *  - `SPLIT_RE` matches the primary delimiters (case-insensitive `i` covers
 *    FEAT. / With / WITH / meets):
 *      - `&` / `＆` (U+FF06 full-width — split runs before NFKC normalisation)
 *        / `,` / `×` / `｜` (U+FF5C full-width vertical bar) with optional
 *        surrounding whitespace
 *      - ` with ` (whitespace-delimited so it never bites mid-word)
 *      - ` meets ` (added 2026-05-04 for `CHiCO with HoneyWorks meets …`)
 *      - `feat.` (any case) with optional surrounding whitespace (catches the
 *        un-parenthesized form like `Artist1 FEAT. Artist2`)
 *
 *    Fix A.2 (2026-05-01): `｜` (U+FF5C) is in the delimiter set. The blog
 *    adapter convention for collab is `Artist1｜Artist2`; without `｜` the
 *    parser admit rule and the merger's Tier C clustering key would silently
 *    drift. Required by `getLeadComponent` to reproduce the canonical Tier C
 *    behavior (`椎名もた｜ぽわぽわP` → lead `椎名もた`).
 *
 *  - `OF_RE` is the ` of ` member-of-group sub-split, applied ONLY to text
 *    captured INSIDE a `(Feat. X)` / `(Prod. X)` parenthetical (Fix 1,
 *    2026-05-01). See the call site for full rationale.
 */
const FEAT_PAREN_RE = /\s*\(\s*(?:feat|prod)\.\s*([^()]+?)\s*\)\s*/gi;
export const SPLIT_RE = /\s*[&＆,×｜]\s*|\s+with\s+|\s+meets\s+|\s*feat\.\s*/i;
const OF_RE = /\s+of\s+/i;

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
 *   'LE SSERAFIM(Prod.imase)' -> ['LE SSERAFIM(Prod.imase)', 'LE SSERAFIM', 'imase']
 *   'MAX(Feat.Huh Yunjin of LE SSERAFIM)' -> ['MAX(Feat.Huh Yunjin of LE SSERAFIM)', 'MAX', 'Huh Yunjin of LE SSERAFIM', 'Huh Yunjin', 'LE SSERAFIM']
 *   '安室奈美恵 with スーパーモンキーズ' -> ['安室奈美恵 with スーパーモンキーズ', '安室奈美恵', 'スーパーモンキーズ']
 *   'Artist1 × Artist2' -> ['Artist1 × Artist2', 'Artist1', 'Artist2']
 *   'YOASOBI' -> ['YOASOBI']
 *   'Bump of Chicken' -> ['Bump of Chicken']  (NOT split — bare ` of ` outside feat/prod)
 *   'Out of the Blue' -> ['Out of the Blue']  (NOT split — bare ` of ` outside feat/prod)
 *   'SUGA of BTS' -> ['SUGA of BTS']          (NOT split as bare input — only inside feat/prod parens)
 *   '' -> []
 *
 * Note on ` of ` scope (Fix 1, 2026-05-01): the ` of ` member-of-group
 * sub-split fires ONLY on text captured INSIDE a `(Feat. X)` / `(Prod. X)`
 * parenthetical. Splitting bare ` of ` at the top level was a footgun — it
 * mangled legitimate names like `Bump of Chicken` (a major Japanese rock
 * band) and `Out of the Blue` into useless head/tail fragments. The
 * motivating cases are exclusively feat/prod parentheticals
 * (`MAX(Feat.SUGA of BTS)` → MAX, SUGA, BTS), so the scope is restricted
 * accordingly.
 */
export function splitArtistCollab(artist: string): string[] {
  const whole = artist.trim();
  if (whole === '') return [];

  // Collect raw parts before dedupe. The whole string is always parts[0]
  // so single-artist names short-circuit on the leading entry and the
  // existing per-record cache path keeps hitting the same key.
  const parts: string[] = [whole];

  // Global pre-pass: extract every `(Feat. X)` / `(FEAT. X)` / `(Prod. X)`
  // parenthetical from anywhere in the string. See `FEAT_PAREN_RE` docblock.
  const featContents: string[] = [];
  let main = whole.replace(FEAT_PAREN_RE, (_, inner: string) => {
    featContents.push(inner);
    return ' ';
  });
  main = main.trim();

  // Split the remaining string on the primary delimiters. See `SPLIT_RE` docblock.
  if (main !== '') {
    const pieces = main.split(SPLIT_RE);
    for (const piece of pieces) {
      const trimmed = piece.trim();
      if (trimmed !== '') parts.push(trimmed);
    }
  }

  // ` of ` member-of-group sub-split: applied ONLY to text captured INSIDE
  // a `(Feat. X)` / `(Prod. X)` parenthetical (Fix 1, 2026-05-01).
  //
  // Why scoped: the ` of ` token semantically means "member-of-group" only
  // inside an explicit feat/prod credit (`(Feat. SUGA of BTS)`). Outside
  // that context, ` of ` is a common English word that appears in real
  // artist names: `Bump of Chicken` (major Japanese rock band),
  // `Out of the Blue`, etc. The previous version of this function fired
  // an unscoped ` of ` split on any post-split part, which would mangle
  // those names into head/tail fragments. Restricting the rule to
  // feat/prod parenthetical content preserves the motivating
  // `MAX(Feat.Huh Yunjin of LE SSERAFIM)` cases while making bare-string
  // ` of ` round-trip unchanged.
  //
  // For each captured feat/prod inner string we:
  //   1. Append the whole inner string (already done above).
  //   2. Additionally split it on ` of ` and append each non-empty token.
  // Dedupe afterward via `normalizeForMatch` collapses overlap.
  for (const fc of featContents) {
    if (fc !== '') parts.push(fc);
    if (fc !== '' && OF_RE.test(fc)) {
      for (const piece of fc.split(OF_RE)) {
        const trimmed = piece.trim();
        if (trimmed !== '') parts.push(trimmed);
      }
    }
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
  // Invariant lock (Fix A.3, 2026-05-01): `parts[0]` is always the trimmed
  // input string. Multiple call sites (parser.ts lead-component admit rule,
  // merge.ts `getLeadComponent`) rely on this contract. A future refactor
  // that drops the whole-string from index 0 would silently flip semantics
  // across every consumer; this assertion makes the contract enforced at
  // runtime instead of implicit.
  if (out.length > 0 && out[0] !== whole) {
    throw new Error(
      'splitArtistCollab invariant: out[0] must equal trimmed input — refactor broke the contract',
    );
  }
  return out;
}

/**
 * Lead-component extractor used by both the TJ-direct parser's lead-component
 * admit rule and the merger's Tier C clustering key (Fix A.2, 2026-05-01).
 *
 * Returns the first NON-WHOLE component from `splitArtistCollab(artist)` —
 * i.e. the lead chunk after collab decoration is stripped — normalized via
 * `normalizeForMatch`. When the input is a single artist (the splitter
 * returns `[whole]` only), falls back to `normalize(whole)` so single-artist
 * names round-trip predictably.
 *
 * Why this lives in the same module as `splitArtistCollab`: pre-Fix-A.2,
 * `merge.ts` had its own `primaryArtistToken` helper with a SUBSET of
 * `splitArtistCollab`'s delimiter set (no `×` or `＆`). Two functions, two
 * delimiter regexes, silent drift risk: the same artist could produce
 * different lead tokens across the two consumers. Unifying through this
 * helper guarantees parser admit rule + merger clustering see the SAME
 * lead-component decision for any input.
 *
 * Examples:
 *   '椎名もた(Feat.鏡音リン)' -> normalize('椎名もた')
 *   '椎名もた｜ぽわぽわP'    -> normalize('椎名もた')
 *   'imase & なとり'         -> normalize('imase')
 *   'Artist1 × Artist2'       -> normalize('Artist1')
 *   'YOASOBI'                 -> normalize('YOASOBI')
 *   ''                        -> ''
 */
export function getLeadComponent(artist: string): string {
  const parts = splitArtistCollab(artist);
  if (parts.length === 0) return '';
  // parts[0] is always the whole-string per the invariant. parts[1] is the
  // lead component when splits fired; otherwise the input is a single artist
  // and parts[0] is itself the lead.
  const lead = parts.length >= 2 ? parts[1] : parts[0];
  if (lead === undefined) return '';
  return normalizeForMatch(lead);
}
