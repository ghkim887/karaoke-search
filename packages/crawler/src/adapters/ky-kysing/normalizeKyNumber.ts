/**
 * Canonical KY (kysing.kr) catalog-number normalization, shared by the KY
 * adapter AND the blog parser's `ky` cell path.
 *
 * Why shared (single source of truth): the merger's Tier A vendor-number union
 * matches on EXACT string equality (`merge.ts` indexes `karaoke_numbers.ky`
 * verbatim, no normalization). If the KY adapter and the blog parser produced
 * even subtly different canonical forms for the same catalog number (e.g. one
 * trimmed, one not), a blog row claiming `ky-{n}` would silently fail to union
 * with the live `ky-{n}` record and the graduation described in the R5 KY
 * adapter design would never fire. Both paths funnel through this one function
 * so the two can never drift.
 *
 * Canonical form: trim surrounding whitespace, require bare ASCII digits, and
 * enforce the shared digit cap. Leading zeros are NOT stripped — the blog cell
 * and the KY index both render the number verbatim, so preserving the exact
 * digit string is what keeps the two byte-identical. Anything else (empty,
 * non-digits, over-cap) returns `null` so the caller drops the value.
 */

/**
 * Maximum digit count for a KY catalog number. Real KY codes observed in the
 * live catalog and the blog corpus are 4–6 digits; the cap is a defensive
 * backstop against a parser glitch fusing two cells. Single-sourced here so the
 * blog parser's `NUMBER_LENGTH_CAPS.ky` and the KY adapter agree by
 * construction (kept in lock-step with the blog's historical `ky: 6`).
 */
export const KY_NUMBER_MAX_DIGITS = 6;

/**
 * Canonicalize a raw KY catalog-number string to the corpus form, or `null`
 * when the value is not a usable bare-digit number within the cap.
 */
export function normalizeKyNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  if (trimmed.length > KY_NUMBER_MAX_DIGITS) return null;
  return trimmed;
}
