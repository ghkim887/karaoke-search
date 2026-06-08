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
 *   - `admit-jp-artist` — admitted as plain jpop on the strength of the
 *     known-Japanese-artist seam without any kana/anime/vocaloid signal; detail
 *     genre/tieup could refine the category to vocaloid or anime.
 *   - `drop-han-only` / `drop-ascii-only` / `drop-no-signal` — dropped for lack
 *     of a positive signal, but detail genre/tieup could reveal an
 *     anime/vocaloid tie-in that would admit it.
 * The remaining reasons are NOT flip-risk:
 *   - `reviewed-allow` / `reviewed-drop` — adjudicated at the exact number,
 *     detail cannot override a human decision.
 *   - `foreign-korean` / `foreign-chinese` / `foreign-western` — a hard negative
 *     act gate; detail genre/tieup never rehabilitates a confirmed foreign act.
 *   - `admit-vocaloid` / `admit-anime` — the strongest positive signals already
 *     fired on the listing; detail can only corroborate, not flip.
 */
const DETAIL_FLIP_RISK_REASONS: ReadonlySet<JoysoundClassifyReason> = new Set([
  'admit-jpop-kana',
  'admit-jp-artist',
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
 * Optional sweep-layer knobs for {@link buildJoysoundDecision}.
 *
 * Both are forwarded to the classifier verbatim; both are optional so the
 * production-equivalent call (`buildJoysoundDecision(listItem)`) is unchanged.
 */
export interface BuildJoysoundDecisionOptions {
  overrides?: JoysoundOverridePredicates;
  /**
   * Injected known-Japanese-artist predicate (Fix F2). The sweep runner builds
   * this from the corpus and passes it here; it enables the `admit-jp-artist`
   * recall path in the classifier. Undefined in production.
   */
  isKnownJapaneseArtist?: (artist: string) => boolean;
}

/**
 * Run the reason-rich classifier over a single JOYSOUND listing row (LISTING
 * LEVEL — no per-song detail) and emit a {@link DecisionRecord}. `decision` is
 * `admit` iff a non-null category was assigned.
 *
 * Accepts either the bare production override predicates (back-compat: the
 * second positional argument may be a `JoysoundOverridePredicates`) or a
 * {@link BuildJoysoundDecisionOptions} bag carrying `overrides` and/or the
 * `isKnownJapaneseArtist` sweep seam. Tests inject a stub to exercise the
 * ALLOW/DROP paths against the (empty) production lists.
 */
/**
 * Disambiguate the overloaded second argument. A {@link JoysoundOverridePredicates}
 * carries `isAllow`/`isDrop`; the options bag does not. The diagnostic test
 * suite passes the bare predicates positionally, so that legacy shape must keep
 * mapping onto `{ overrides }`.
 */
function normalizeBuildOptions(
  arg?: BuildJoysoundDecisionOptions | JoysoundOverridePredicates,
): BuildJoysoundDecisionOptions {
  if (arg === undefined) return {};
  if (typeof (arg as JoysoundOverridePredicates).isAllow === 'function') {
    return { overrides: arg as JoysoundOverridePredicates };
  }
  return arg as BuildJoysoundDecisionOptions;
}

export function buildJoysoundDecision(
  listItem: JoysoundListItem,
  optionsOrOverrides?: BuildJoysoundDecisionOptions | JoysoundOverridePredicates,
): DecisionRecord {
  const options = normalizeBuildOptions(optionsOrOverrides);
  const { category, reason } = classifyJoysoundRecordWithReason({
    listItem,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.isKnownJapaneseArtist
      ? { isKnownJapaneseArtist: options.isKnownJapaneseArtist }
      : {}),
  });
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
