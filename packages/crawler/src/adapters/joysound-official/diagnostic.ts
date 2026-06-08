import type { Category } from '@karaoke/schema';
import {
  type JoysoundClassifyReason,
  type JoysoundOverridePredicates,
  classifyJoysoundRecordWithReason,
} from './classifier.js';
import { normalizeJoysoundNumber } from './normalizer.js';
import type { JoysoundListItem } from './types.js';

/**
 * One decision-log row emitted by the JOYSOUND full-catalog FP/FN sweep. This
 * is the JSONL contract consumed downstream by `analyzeJoysoundDatabase`.
 */
export interface DecisionRecord {
  /** Canonical (hyphen-stripped) JOYSOUND number, e.g. `190001`. */
  selSongNo: string;
  /** The original listing `selSongNo` before hyphen-strip, e.g. `190-001`. */
  selSongNoRaw: string;
  naviGroupId: string;
  title: string;
  artist: string;
  tieupInfo: string | null;
  decision: 'admit' | 'drop';
  category: Category | null;
  reason: JoysoundClassifyReason;
  /**
   * `true` when the LISTING-ONLY verdict could change if per-song detail
   * (`genreNames` / `tieupNames`) were available. See {@link isDetailFlipRisk}.
   */
  detailFlipRisk: boolean;
}

/**
 * Reasons whose listing-only verdict could flip if per-song detail were
 * fetched.
 *
 * Heuristic: detail adds `genreNames` (vocaloid signal) and `tieupNames` (anime
 * signal) that the listing row lacks. So:
 *   - `admit-jpop-kana` — admitted as plain jpop, but detail genre/tieup could
 *     reveal it is really vocaloid or an anime tie-in.
 *   - `drop-han-only` / `drop-ascii-only` / `drop-no-signal` — dropped for lack
 *     of a positive signal, but detail genre/tieup could reveal an
 *     anime/vocaloid tie-in that would admit it.
 * The remaining reasons are NOT flip-risk:
 *   - `reviewed-allow` / `reviewed-drop` — adjudicated at the exact number,
 *     detail cannot override a human decision.
 *   - `foreign-korean` / `foreign-western` — a hard negative act gate; detail
 *     genre/tieup never rehabilitates a confirmed foreign act.
 *   - `admit-vocaloid` / `admit-anime` — the strongest positive signals already
 *     fired on the listing; detail can only corroborate, not flip.
 */
const DETAIL_FLIP_RISK_REASONS: ReadonlySet<JoysoundClassifyReason> = new Set([
  'admit-jpop-kana',
  'drop-han-only',
  'drop-ascii-only',
  'drop-no-signal',
]);

function isDetailFlipRisk(reason: JoysoundClassifyReason): boolean {
  return DETAIL_FLIP_RISK_REASONS.has(reason);
}

/**
 * Normalize a listing `selSongNo` to its canonical (hyphen-stripped) key,
 * falling back to a plain hyphen-strip when the value is not digits-only.
 * `normalizeJoysoundNumber` throws on a non-digit value (it guards the
 * normalizer's schema contract); the diagnostic must instead log every row, so
 * an anomalous number is hyphen-stripped and recorded as-is rather than aborting
 * the sweep.
 */
function canonicalSelSongNo(raw: string): string {
  try {
    return normalizeJoysoundNumber(raw);
  } catch {
    return raw.replace(/-/g, '').trim();
  }
}

/**
 * Run the reason-rich classifier over a single JOYSOUND listing row (LISTING
 * LEVEL — no per-song detail) and emit a {@link DecisionRecord}. `decision` is
 * `admit` iff a non-null category was assigned.
 *
 * `overrides` defaults to the production override predicates; tests inject a
 * stub to exercise the ALLOW/DROP paths against the (empty) production lists.
 */
export function buildJoysoundDecision(
  listItem: JoysoundListItem,
  overrides?: JoysoundOverridePredicates,
): DecisionRecord {
  const { category, reason } = classifyJoysoundRecordWithReason(
    overrides ? { listItem, overrides } : { listItem },
  );
  return {
    selSongNo: canonicalSelSongNo(listItem.selSongNo),
    selSongNoRaw: listItem.selSongNo,
    naviGroupId: listItem.naviGroupId,
    title: listItem.songName,
    artist: listItem.artistName,
    tieupInfo: listItem.tieupInfo ?? null,
    decision: category !== null ? 'admit' : 'drop',
    category,
    reason,
    detailFlipRisk: isDetailFlipRisk(reason),
  };
}
