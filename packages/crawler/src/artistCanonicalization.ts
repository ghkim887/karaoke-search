/**
 * NFKC-variant canonicalization for `artist_primary`.
 *
 * The corpus contains 18 groups where multiple `artist_primary` strings
 * normalize to the same key under `NFKC + toLowerCase` but are stored as
 * distinct surface forms (e.g. "BUMP OF CHICKEN" vs "Bump of Chicken").
 * These split Tier B clustering and fragment search result sets.
 *
 * This module provides:
 *   - `CANONICALIZATION_RULES`: the 20 hardcoded `from → to` rewrite rules
 *     derived from the May 2026 data audit (18 groups, some with >1 minority
 *     form). Canonical = highest record count; ties broken alphabetically.
 *   - `canonicalizeArtistName(name)`: pure function — returns the canonical
 *     surface form when `name` matches a rule's `from`, otherwise `name`.
 *
 * Wiring: called inside `resolveArtistAliases` as Phase 4 (after Phase 3
 * re-keying). Applied only to bare records (no full-width pipe in
 * `artist_primary`) — pipe-form records are already canonical after Phase 1.
 *
 * Original minority forms are added to `artist_aliases` on rewritten records
 * so search recall is preserved (users searching "Bump of Chicken" still hit
 * records whose `artist_primary` is now "BUMP OF CHICKEN").
 */

export interface CanonicalizationRule {
  /** Minority surface form to rewrite away from. */
  from: string;
  /** Canonical surface form to rewrite to (majority by record count). */
  to: string;
  /** Human-readable reason for the rule (optional, for audit trail). */
  reason?: string;
}

/**
 * 20 rules covering the 18 NFKC-equivalent artist_primary groups found in
 * the May 2026 corpus audit. Two groups have 2 minority forms each (JUDY AND
 * MARY, KinKi Kids), yielding 20 total rules.
 *
 * Rule selection criteria:
 *   - Canonical = form with the highest record count.
 *   - Ties broken alphabetically (earlier string wins).
 *   - Groups where any minority form appears in `artist_aliases` arrays or is
 *     pipe-distinguished were excluded (already handled by the alias resolver).
 */
export const CANONICALIZATION_RULES: CanonicalizationRule[] = [
  { from: 'Dreams Come True', to: 'DREAMS COME TRUE', reason: '314 vs 12 records' },
  { from: 'Unison Square Garden', to: 'UNISON SQUARE GARDEN', reason: '176 vs 3 records' },
  { from: 'BOA', to: 'BoA', reason: '174 vs 1 record' },
  { from: 'LISA', to: 'LiSA', reason: '160 vs 14 records' },
  { from: 'Bump of Chicken', to: 'BUMP OF CHICKEN', reason: '125 vs 20 records' },
  { from: 'Mrs. Green Apple', to: 'Mrs. GREEN APPLE', reason: '133 vs 6 records' },
  { from: 'Judy and Mary', to: 'JUDY AND MARY', reason: '61 vs 11 records' },
  { from: 'Judy And Mary', to: 'JUDY AND MARY', reason: '61 vs 1 record' },
  { from: 'Kinki Kids', to: 'KinKi Kids', reason: '34 vs 2 records' },
  { from: 'Kinki kids', to: 'KinKi Kids', reason: '34 vs 2 records' },
  { from: 'PEOPLE 1', to: 'People 1', reason: '36 vs 1 record' },
  { from: 'Ano', to: 'ano', reason: '30 vs 3 records' },
  { from: 'Chemistry', to: 'CHEMISTRY', reason: '14 vs 1 record' },
  { from: 'Luna Sea', to: 'Luna sea', reason: '12 vs 1 record' },
  { from: 'タッキー&翼', to: 'タッキー＆翼', reason: '11 vs 1 record (full-width & normalization)' },
  { from: 'Lia', to: 'LIA', reason: '3 vs 3 records — alphabetical tiebreak' },
  { from: 'Hitomi', to: 'hitomi', reason: '4 vs 1 record' },
  { from: 'TK from 凛として時雨', to: 'TK From 凛として時雨', reason: '2 vs 1 record' },
  { from: 'I WiSH', to: 'I WISH', reason: '1 vs 1 record — alphabetical tiebreak' },
  { from: '4 In love', to: '4 In Love', reason: '1 vs 1 record — alphabetical tiebreak' },
];

/**
 * Exact-string lookup map built from CANONICALIZATION_RULES for O(1) lookup.
 * Key = `from` surface form (exact, case-sensitive); value = `to` form.
 */
const _ruleMap = new Map<string, string>(
  CANONICALIZATION_RULES.map((r) => [r.from, r.to]),
);

/**
 * Returns the canonical surface form for `name` when it matches a
 * canonicalization rule, otherwise returns `name` unchanged.
 *
 * The lookup is exact and case-sensitive: the rules target specific surface
 * forms, not a normalized key, so this function does NOT call `.normalize()`
 * or `.toLowerCase()` internally. The rule `from` strings are the minority
 * forms exactly as they appear in the corpus.
 */
export function canonicalizeArtistName(name: string): string {
  return _ruleMap.get(name) ?? name;
}
