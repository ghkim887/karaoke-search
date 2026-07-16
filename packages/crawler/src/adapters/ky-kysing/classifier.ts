import { hasSimplifiedOnlyHan } from '@karaoke/search';
import { normalizeForMatch, splitArtistCollab } from '../../clustering.js';
import { isInChineseDropList } from '../../curated/chineseArtistDropList.js';
import { isInDropList } from '../../curated/koreanArtistDropList.js';
import { isReviewedKyAllow, isReviewedKyDrop } from './reviewedKySongOverrides.js';

/**
 * #97-gate script discriminator, byte-mirrored from the TJ filter seam
 * (`tj-media-direct/filterSteps.ts` `readsAsKoreanScript`, itself mirrored from
 * `product-corpus-regression.test.ts`). A row "reads as Korean script" when it
 * contains a Hangul SYLLABLE and NO Japanese-script character (any kana, or any
 * CJK ideograph incl. extension A).
 *
 * `@karaoke/search` `hasHangul` is intentionally NOT reused (owner decision
 * #143): it also matches jamo / compatibility jamo, a strictly broader class
 * than the gate's syllable-only `/[가-힣]/`, so a Japanese title carrying a
 * stray jamo would over-reject. Keep these two character classes byte-identical
 * to the TJ mirror so the KY guard rejects exactly the Korean-script rows the
 * TJ seam does.
 */
const RE_HANGUL = /[가-힣]/;
const RE_JAPANESE = /[぀-ヿ㐀-鿿]/;

/** True when `text` reads as Korean script: a Hangul syllable AND no Japanese script. */
function readsAsKoreanScript(text: string): boolean {
  return RE_HANGUL.test(text) && !RE_JAPANESE.test(text);
}

/**
 * Which gate decided a KY row. `reviewed-allow` / `admit-*` are ADMIT verdicts;
 * everything else is a DROP verdict. The reason is the audit value — WHY the
 * row was admitted or dropped.
 *
 *  - `reviewed-allow` / `reviewed-drop` — exact-number curated override hit.
 *  - `drop-korean-artist` / `drop-chinese-artist` — a collab component is on the
 *    curated Korean / Chinese artist drop list (any-component scan).
 *  - `drop-korean-script` — the row reads as Korean script (#97-gate mirror).
 *  - `drop-simplified-han` — the row carries a curated simplified-Chinese-only
 *    Han character (a Mandopop/Cantopop leak signal).
 *  - `admit-index` — admitted straight from the index render.
 *  - `admit-title-recovered` — admitted after a truncated index row's title (and
 *    artist) was recovered from the curated title-recovery map.
 */
export type KyClassifyReason =
  | 'reviewed-allow'
  | 'reviewed-drop'
  | 'drop-korean-artist'
  | 'drop-chinese-artist'
  | 'drop-korean-script'
  | 'drop-simplified-han'
  | 'admit-index'
  | 'admit-title-recovered';

/**
 * The decision-log STEP a reason belongs to (D8 observability). One step per
 * gate phase plus the operational recovery/parse steps the crawler stamps
 * directly (`truncation-recovery` for `truncation-unrecovered`, and `index` /
 * `null` for `row-parse-error`).
 */
export type KyDecisionStep =
  | 'reviewed-override'
  | 'drop-list'
  | 'script-guard'
  | 'truncation-recovery'
  | 'index';

/** Map a classifier reason to its decision-log step. */
export function kyStepForReason(reason: KyClassifyReason): KyDecisionStep {
  switch (reason) {
    case 'reviewed-allow':
    case 'reviewed-drop':
      return 'reviewed-override';
    case 'drop-korean-artist':
    case 'drop-chinese-artist':
      return 'drop-list';
    case 'drop-korean-script':
    case 'drop-simplified-han':
      return 'script-guard';
    case 'admit-title-recovered':
      return 'truncation-recovery';
    case 'admit-index':
      return 'index';
  }
}

/**
 * Override-predicate seam. Defaults to the production `reviewedKySongOverrides`
 * predicates; tests inject stubs to exercise the ALLOW/DROP paths against the
 * (intentionally empty) production lists without duplicating classification
 * logic. Mirrors the JOYSOUND classifier's override seam.
 */
export interface KyOverridePredicates {
  isAllow: (ky: string) => boolean;
  isDrop: (ky: string) => boolean;
}

const DEFAULT_OVERRIDES: KyOverridePredicates = {
  isAllow: isReviewedKyAllow,
  isDrop: isReviewedKyDrop,
};

export interface KyClassifyArgs {
  ky: string;
  title: string;
  artist: string;
  /** True when title/artist were recovered from the curated map (picks the admit reason). */
  recovered?: boolean;
  overrides?: KyOverridePredicates;
}

/**
 * Semantic phase of a KY classify gate. The gate array runs strictly in the
 * order these phases are declared in {@link PHASE_ORDER}; {@link assertPhaseOrder}
 * enforces it at module load so a reorder fails fast at import time rather than
 * silently shipping a mis-ordered pipeline (mirrors the JOYSOUND / TJ pattern).
 *
 * Order (owner-approved KY spec, 2026-07-16):
 *   1. reviewed-allow — curated ALLOW admits first (before the drop gates).
 *   2. reviewed-drop  — curated DROP.
 *   3. drop-list      — curated Korean / Chinese artist drop list (any component).
 *   4. script-guard   — Korean-script (#97 mirror) then simplified-Han leak.
 *   5. admit          — terminal admit (index or detail-repaired).
 */
export type KyGatePhase =
  | 'reviewed-allow'
  | 'reviewed-drop'
  | 'drop-list'
  | 'script-guard'
  | 'admit';

export const PHASE_ORDER: readonly KyGatePhase[] = [
  'reviewed-allow',
  'reviewed-drop',
  'drop-list',
  'script-guard',
  'admit',
];

type KyGateVerdict =
  | { decision: 'admit'; reason: KyClassifyReason }
  | { decision: 'drop'; reason: KyClassifyReason }
  | { decision: 'pass' };

/** Precomputed row surfaces shared by every gate, built once per record. */
interface KyClassifyContext {
  ky: string;
  recovered: boolean;
  overrides: KyOverridePredicates;
  /** Collab components of the artist (any-component drop-list scan). */
  components: string[];
  /** `${title} ${artist}` — the script-guard surface. */
  surface: string;
}

export interface KyGate {
  /** Stable name (matches the reason/phase it stamps); used in test assertions. */
  name: string;
  phase: KyGatePhase;
  evaluate: (ctx: KyClassifyContext) => KyGateVerdict;
}

const reviewedAllowGate: KyGate = {
  name: 'reviewed-allow',
  phase: 'reviewed-allow',
  evaluate({ ky, overrides }): KyGateVerdict {
    if (overrides.isAllow(ky)) return { decision: 'admit', reason: 'reviewed-allow' };
    return { decision: 'pass' };
  },
};

const reviewedDropGate: KyGate = {
  name: 'reviewed-drop',
  phase: 'reviewed-drop',
  evaluate({ ky, overrides }): KyGateVerdict {
    if (overrides.isDrop(ky)) return { decision: 'drop', reason: 'reviewed-drop' };
    return { decision: 'pass' };
  },
};

const dropListGate: KyGate = {
  name: 'drop-list',
  phase: 'drop-list',
  evaluate({ components }): KyGateVerdict {
    for (const component of components) {
      const key = normalizeForMatch(component);
      if (isInDropList(key)) return { decision: 'drop', reason: 'drop-korean-artist' };
      if (isInChineseDropList(key)) return { decision: 'drop', reason: 'drop-chinese-artist' };
    }
    return { decision: 'pass' };
  },
};

const scriptGuardGate: KyGate = {
  name: 'script-guard',
  phase: 'script-guard',
  evaluate({ surface }): KyGateVerdict {
    if (readsAsKoreanScript(surface)) return { decision: 'drop', reason: 'drop-korean-script' };
    if (hasSimplifiedOnlyHan(surface)) return { decision: 'drop', reason: 'drop-simplified-han' };
    return { decision: 'pass' };
  },
};

const admitGate: KyGate = {
  name: 'admit',
  phase: 'admit',
  evaluate({ recovered }): KyGateVerdict {
    return { decision: 'admit', reason: recovered ? 'admit-title-recovered' : 'admit-index' };
  },
};

/**
 * AUTHORITATIVE gate order (single source of truth). Enforced at module load by
 * {@link assertPhaseOrder}: a reorder that slid an admit gate ahead of a drop
 * gate — a foreign-leak class bug — throws at import time.
 */
export const KY_GATES: readonly KyGate[] = [
  reviewedAllowGate,
  reviewedDropGate,
  dropListGate,
  scriptGuardGate,
  admitGate,
];

/**
 * Structurally enforce the load-bearing gate order: every gate's phase must
 * appear in non-decreasing {@link PHASE_ORDER} rank as the array is traversed.
 * Exported so tests can assert both the real array passes and a reordered array
 * is rejected.
 */
export function assertPhaseOrder(gates: readonly KyGate[]): void {
  let prevRank = -1;
  let prevGate: KyGate | undefined;
  for (const gate of gates) {
    const rank = PHASE_ORDER.indexOf(gate.phase);
    if (rank === -1) {
      throw new Error(
        `KY_GATES phase check: gate "${gate.name}" has phase "${gate.phase}" which is not in PHASE_ORDER [${PHASE_ORDER.join(' → ')}].`,
      );
    }
    if (rank < prevRank && prevGate !== undefined) {
      throw new Error(
        `KY_GATES order violation: "${gate.name}" (phase "${gate.phase}") runs after "${prevGate.name}" (phase "${prevGate.phase}"), but "${gate.phase}" must not precede "${prevGate.phase}" per PHASE_ORDER [${PHASE_ORDER.join(' → ')}]. The KY classify gate order is load-bearing.`,
      );
    }
    prevRank = rank;
    prevGate = gate;
  }
}

// Fail fast at import time if the gate array is ever reordered out of policy.
assertPhaseOrder(KY_GATES);

/**
 * Classify a KY row into an admit/drop verdict + reason. Runs {@link KY_GATES}
 * in {@link PHASE_ORDER}, short-circuiting on the first admit/drop; the terminal
 * admit gate always decides, so the loop always returns (the post-loop
 * fall-through only keeps the reducer total over any gate array).
 */
export function classifyKyRow({
  ky,
  title,
  artist,
  recovered = false,
  overrides = DEFAULT_OVERRIDES,
}: KyClassifyArgs): { admit: boolean; reason: KyClassifyReason } {
  const ctx: KyClassifyContext = {
    ky,
    recovered,
    overrides,
    components: splitArtistCollab(artist),
    surface: `${title} ${artist}`,
  };
  for (const gate of KY_GATES) {
    const verdict = gate.evaluate(ctx);
    if (verdict.decision === 'pass') continue;
    return { admit: verdict.decision === 'admit', reason: verdict.reason };
  }
  return { admit: true, reason: recovered ? 'admit-title-recovered' : 'admit-index' };
}
