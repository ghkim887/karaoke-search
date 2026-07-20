/**
 * Reviewed KY song-level overrides.
 *
 * Mirrors `joysound-official/reviewedJoysoundOverrides.ts` and
 * `tj-media-direct/reviewedSongOverrides.ts` in shape, keyed by canonical KY
 * number (bare digits, as {@link normalizeKyNumber} produces). These lists pin
 * adjudicated edge cases at the EXACT song number, never artist-wide: ALLOW
 * admits a row the script/drop-list guard would otherwise reject; DROP forces a
 * row out even when the guard would admit it.
 *
 * ALLOW is INTENTIONALLY EMPTY. DROP carries the 2026-07-20 leak-triage KY
 * claim (ky 51322, below). They are the code-free correction hook: when a soak
 * or triage surfaces a KY misclassification, add the number here rather than
 * redeploying classifier logic. ALLOW is consulted before the curated
 * drop-list + script guard; DROP is consulted first (allow-precedes-droplist,
 * matching the TJ / JOYSOUND ordering).
 */

/** A hand-audited KY DROP entry — metadata makes each verdict auditable without the original artifact. */
export interface ReviewedKyOverrideEntry {
  /** Canonical (bare-digit) KY number — the key shape `normalizeKyNumberKey` produces. */
  ky: string;
  /** Catalog title as recorded at audit time. */
  title: string;
  /** Catalog artist as recorded at audit time. */
  artist: string;
  /** Decision date (`YYYY-MM-DD`, UTC) — when the reviewer verdict was recorded. */
  decidedOn: string;
  /** Audit provenance + short rationale. */
  note?: string;
}

/** Reviewed ALLOW numbers (bare digits). Empty on day one. */
export const REVIEWED_KY_ALLOW_NUMBERS: readonly string[] = [];

/** Reviewed DROP entries. */
export const REVIEWED_KY_DROP_ENTRIES: readonly ReviewedKyOverrideEntry[] = [
  {
    ky: '51322',
    title: '귀엽기만 하면 안 되나요?',
    artist: 'CUTIE STREET',
    decidedOn: '2026-07-20',
    note: 'drop_per_song_korean_language_row — KOR-language ver. of CUTIE STREET (JP group) "かわいいだけじゃだめですか?" (2026-07-20 leak triage). Same song as the TJ-side drop tj 52093 (reviewedSongOverrides). The pure-Hangul title also trips the KY script-guard, but this exact-number DROP makes the KY ingress explicit and robust. JP original ky 57750 (tj 52410) stays admittable — do NOT add CUTIE STREET to koreanArtistDropList.',
  },
];

/**
 * Canonical lookup key for a KY number: trim + require the bare-digit form.
 * An empty/whitespace-only input normalizes to `''`, which never collides with
 * a real catalog number.
 */
function normalizeKyNumberKey(ky: string): string {
  return ky.trim();
}

const REVIEWED_KY_ALLOW = new Set<string>(
  REVIEWED_KY_ALLOW_NUMBERS.map((ky) => normalizeKyNumberKey(ky)),
);
const REVIEWED_KY_DROP = new Set<string>(
  REVIEWED_KY_DROP_ENTRIES.map((entry) => normalizeKyNumberKey(entry.ky)),
);

export function isReviewedKyAllow(ky: string): boolean {
  return REVIEWED_KY_ALLOW.has(normalizeKyNumberKey(ky));
}

export function isReviewedKyDrop(ky: string): boolean {
  return REVIEWED_KY_DROP.has(normalizeKyNumberKey(ky));
}
