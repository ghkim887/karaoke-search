/**
 * Reviewed JOYSOUND song-level overrides from the 2026-06 FP/FN audit.
 *
 * Mirrors `tj-media-direct/reviewedSongOverrides.ts` in shape, but keys by
 * canonical (hyphen-stripped) JOYSOUND number instead of TJ number. These lists
 * encode Gyunho's policy that adjudicated edge cases — K-pop/Korean-artist
 * Japanese releases, specific false positives — are pinned at the exact song
 * number, never artist-wide. ALLOW is consulted before the foreign-act gate;
 * DROP is consulted first (mirrors TJ's allow-precedes-droplist ordering).
 *
 * Source artifact: 2026-06-09 JOYSOUND full-catalog FP/FN sweep (decision-log +
 * analyzeJoysoundDatabase review queues). The lists START EMPTY — adjudicated
 * numbers are appended as the P0/P1 queues are worked.
 * Counts: allow=0, drop=0.
 */

const REVIEWED_JOYSOUND_ALLOW_NUMBERS = [] as const;

const REVIEWED_JOYSOUND_DROP_NUMBERS = [] as const;

const REVIEWED_JOYSOUND_ALLOW = new Set<string>(REVIEWED_JOYSOUND_ALLOW_NUMBERS);
const REVIEWED_JOYSOUND_DROP = new Set<string>(REVIEWED_JOYSOUND_DROP_NUMBERS);

export function isReviewedJoysoundAllow(selSongNo: string): boolean {
  return REVIEWED_JOYSOUND_ALLOW.has(normalizeJoysoundNumberKey(selSongNo));
}

export function isReviewedJoysoundDrop(selSongNo: string): boolean {
  return REVIEWED_JOYSOUND_DROP.has(normalizeJoysoundNumberKey(selSongNo));
}

/**
 * Canonical lookup key for a JOYSOUND number: strip ALL hyphens (`190-001` →
 * `190001`, matching `normalizeJoysoundNumber` in `normalizer.ts`) and trim
 * surrounding whitespace. An empty/whitespace-only input normalizes to `''`,
 * which never collides with a real catalog number.
 */
function normalizeJoysoundNumberKey(selSongNo: string): string {
  const trimmed = selSongNo.trim();
  if (trimmed === '') return '';
  return trimmed.replace(/-/g, '');
}
