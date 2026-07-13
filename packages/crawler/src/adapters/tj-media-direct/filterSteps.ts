/**
 * Typed FilterStep[] reducer for the TJ-direct classifyRecord filter chain.
 *
 * CLAUDE.md gotcha: the filter chain ORDER IS LOAD-BEARING. Do NOT reorder
 * FILTER_STEPS. Authoritative order: see the numbered list on the
 * FILTER_STEPS array at the bottom of this file — that docblock is the ONE
 * source of truth for the step order; everything else points here.
 *
 * Each step returns a tagged FilterVerdict:
 *   - { decision: 'admit'; via: KeepVerdict }  → stop, keep the record
 *   - { decision: 'reject'; reason: string }    → stop, drop the record
 *   - { decision: 'pass' }                      → continue to next step
 *
 * The reducer in classifyRecord (parser.ts) iterates FILTER_STEPS in order and
 * short-circuits on the first non-'pass' verdict.
 */

import { hasSimplifiedOnlyHan } from '@karaoke/search';
import { isInChineseDropList } from '../../curated/chineseArtistDropList.js';
import { isInDropList } from '../../curated/koreanArtistDropList.js';
import type { SearchSongCache } from './cache.js';
import { normalizeForMatch, splitArtistCollab } from './normalize.js';
import type { KeepVerdict } from './parser.js';
import { isReviewedTjSongAllow, isReviewedTjSongDrop } from './reviewedSongOverrides.js';

/**
 * Artist-level nationality tags are unsafe for deliberately generic bucket
 * names. A few real JP rows can make `Various Artists` look JPN, but that
 * must not blanket-admit every Korean OST / BGM row carrying the same artist.
 * Let per-pro JPN evidence or the JP-likely rescue path admit genuine rows.
 */
const GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST = new Set([
  'variousartists',
  'variousartist',
  'unknownartist',
  'unknown',
  'omnibus',
  'オムニバス',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

type FilterVerdict =
  | { decision: 'admit'; via: KeepVerdict }
  | { decision: 'reject'; reason: string }
  | { decision: 'pass' };

export interface FilterContext {
  /** Stringified TJ catalog number. */
  tj: string;
  /**
   * Raw title string from `indexTitle` (trimmed). Threaded for the
   * jpn-admit-artist script guard, which reads `${title} ${artist}` — the same
   * text the #97 corpus gate scans. Not used by any other step.
   */
  title: string;
  /** Raw artist string from `indexSong`. */
  artist: string;
  /** Collab-split components (pre-computed once per record). */
  components: string[];
  /** Shared searchSong enrichment cache. */
  cache: SearchSongCache;
  /** Blog-whitelist TJ numbers for the rescue path (may be undefined). */
  force: ReadonlySet<string> | undefined;
}

/**
 * Semantic role of a filter step. The chain runs strictly in the order these
 * phases are declared in {@link PHASE_ORDER}; that declaration IS the owner
 * policy (docs/PROJECT-KNOWLEDGE.md §"TJ filter chain"). Each phase maps to
 * exactly one step today, so "the phase order" and "the step order" coincide —
 * the point is that the order is now expressed as data the module can verify,
 * not just an array literal + prose comments that a reorder would silently pass.
 *
 * The two admit paths are split into `admit-pro` / `admit-artist` (rather than a
 * single `admit` phase) on purpose: when a record matches BOTH a JPN pro tag and
 * a JPN lead-artist tag, whichever step runs first wins the admit and stamps the
 * observable `via` counter (KeepStats `admittedByPro` vs `admittedByArtist`).
 * The doc ranks the per-song pro `nationalcode` as the stronger signal, so
 * `admit-pro` must precede `admit-artist` — that relative order is load-bearing.
 */
export type FilterPhase =
  | 'hard-drop'
  | 'override-reject'
  | 'curated-allow'
  | 'deny-list'
  | 'admit-pro'
  | 'admit-artist'
  | 'rescue';

/**
 * Declared phase order — the single machine-checkable statement of the
 * load-bearing chain order. {@link assertPhaseOrder} runs at module load and
 * throws if {@link FILTER_STEPS} is not sorted by this sequence, so a reorder of
 * the array (or a step tagged out of policy order) fails fast at import time
 * instead of silently shipping a mis-ordered pipeline.
 */
export const PHASE_ORDER: readonly FilterPhase[] = [
  'hard-drop',
  'override-reject',
  'curated-allow',
  'deny-list',
  'admit-pro',
  'admit-artist',
  'rescue',
];

export interface FilterStep {
  /** Stable name used as a key in KeepStats counters and for test assertions. */
  name: string;
  /** Semantic phase; enforced against {@link PHASE_ORDER} at module load. */
  phase: FilterPhase;
  evaluate: (ctx: FilterContext) => FilterVerdict;
}

/**
 * Lead component of a pre-split `FilterContext.components` array.
 *
 * `splitArtistCollab` places the whole input string at index 0 and the lead
 * component at index 1 when any split fired — so the lead is index 1 for ≥2
 * elements, else index 0 (single artist, the whole string IS the lead).
 * Returns `undefined` for an empty array.
 *
 * Deliberately NOT clustering.ts's `getLeadComponent(artist)`: that helper
 * takes the RAW string and re-splits + normalizes internally, which would
 * diverge whenever `ctx.components` was built separately from `ctx.artist`
 * (the unit tests do exactly that). This operates on the precomputed array.
 */
function leadComponentOf(components: string[]): string | undefined {
  return components.length >= 2 ? components[1] : components[0];
}

/**
 * Normalized match key for the lead component, or '' when there is no usable
 * lead (empty components, or a lead that normalizes away). Shared by the two
 * lead-driven steps (jpn-admit-artist, blog-rescue) so both derive the key the
 * same way.
 */
function leadKeyOf(components: string[]): string {
  const lead = leadComponentOf(components);
  return lead === undefined ? '' : normalizeForMatch(lead);
}

/**
 * True when the lead component is a deliberately generic bucket name that must
 * never blanket-admit on a JPN artist tag or blog rescue (see
 * {@link GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST}). An empty key is never blocked.
 *
 * Extracted from the duplicated check in jpn-admit-artist and blog-rescue; the
 * `leadKey !== ''` guard reproduces both call sites exactly (jpn-admit-artist
 * only reaches the check with a non-empty key; blog-rescue guarded it inline).
 */
function isGenericAdmitBlocked(leadKey: string): boolean {
  return leadKey !== '' && GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST.has(leadKey);
}

/**
 * #97-gate script discriminator, byte-mirrored from the product-corpus
 * regression gate (packages/crawler/test/product-corpus-regression.test.ts:
 * `RE_HANGUL` / `RE_JAPANESE`). A row "reads as Korean script" when it contains
 * a Hangul SYLLABLE and NO Japanese-script character (any kana, or any CJK
 * ideograph incl. extension A). These two character classes MUST stay
 * byte-identical to that gate so the filter-seam guard below self-rejects
 * exactly the rows the gate flags as leakage.
 *
 * `hasHangul` from `@karaoke/search` is intentionally NOT reused: it matches
 * jamo and compatibility jamo too, a strictly broader class than the gate's
 * syllable-only `/[가-힣]/`, so it is not byte-equivalent.
 */
const RE_HANGUL = /[가-힣]/;
const RE_JAPANESE = /[぀-ヿ㐀-鿿]/;

/**
 * True when `text` reads as Korean script by the #97-gate discriminator above:
 * a Hangul syllable present AND no Japanese-script character.
 */
function readsAsKoreanScript(text: string): boolean {
  return RE_HANGUL.test(text) && !RE_JAPANESE.test(text);
}

// ---------------------------------------------------------------------------
// Step implementations, declared in pipeline order (see FILTER_STEPS below
// for the authoritative order — the array literal defines execution order)
// ---------------------------------------------------------------------------

/**
 * Step 0 — Reviewed song-level drop.
 *
 * Hand-audited false positives are keyed by TJ number. They stay out even if a
 * stale generic artist cache or the blog whitelist would otherwise admit them.
 */
const reviewedSongDropStep: FilterStep = {
  name: 'reviewed-song-drop',
  phase: 'hard-drop',
  evaluate({ tj }): FilterVerdict {
    if (isReviewedTjSongDrop(tj)) return { decision: 'reject', reason: 'reviewed-song-drop' };
    return { decision: 'pass' };
  },
};

/**
 * Step 1 — Explicit non-JPN pro reject.
 *
 * CLAUDE.md gotcha: an explicit non-JPN `nationalcode` from the searchSong
 * enrichment overrules every admit path (including reviewed-song-allow and the
 * blog rescue). Defense against stale or overly broad blog rescue data.
 */
const nonJpnProRejectStep: FilterStep = {
  name: 'non-jpn-pro-reject',
  phase: 'override-reject',
  evaluate({ tj, cache }): FilterVerdict {
    const proEntry = cache.proEnrichmentMap[tj];
    if (proEntry?.nationalcode && proEntry.nationalcode !== 'JPN') {
      return { decision: 'reject', reason: 'pro-non-jpn' };
    }
    return { decision: 'pass' };
  },
};

/**
 * Step 2 — Reviewed song-level allow.
 *
 * K-pop/Korean-artist Japanese releases are deliberately allowed only by their
 * exact TJ number, never by blanket artist allowlisting. This is the curated
 * exception that precedes drop-list-reject (step 3): the 105 audited releases
 * are admitted here even though their artist is on the Korean drop list.
 */
const reviewedSongAllowStep: FilterStep = {
  name: 'reviewed-song-allow',
  phase: 'curated-allow',
  evaluate({ tj }): FilterVerdict {
    if (isReviewedTjSongAllow(tj)) return { decision: 'admit', via: 'song-override' };
    return { decision: 'pass' };
  },
};

/**
 * Step 3 — Drop-list reject (any-component).
 *
 * CLAUDE.md gotcha (§2.E): Hand-curated Korean + Chinese (Cantopop/Mandopop)
 * acts that leak despite the cache signal. Applies to EVERY collab component
 * (inverse of jpn-admit-artist's lead-only admit rule): a Japanese-led record
 * featuring SUGA of BTS still drops. This overrides every admit path that
 * follows it — jpn-admit-pro, jpn-admit-artist, and the blog rescue. The one
 * exception is reviewed-song-allow (step 2): the curated exact-TJ-number K-pop
 * Japanese releases are admitted before this reject runs.
 */
const dropListRejectStep: FilterStep = {
  name: 'drop-list-reject',
  phase: 'deny-list',
  evaluate({ components }): FilterVerdict {
    for (const component of components) {
      const key = normalizeForMatch(component);
      if (isInDropList(key)) return { decision: 'reject', reason: 'korean-drop-list' };
      if (isInChineseDropList(key)) return { decision: 'reject', reason: 'chinese-drop-list' };
    }
    return { decision: 'pass' };
  },
};

/**
 * Step 4 — Per-pro JPN tag.
 *
 * CLAUDE.md gotcha: catches the case where the artist scan was AMBIGUOUS or
 * UNKNOWN but the specific `pro` is JPN. Runs AFTER drop-list-reject (step 3)
 * so a drop-listed Korean act with a JPN pro tag can't leak through here.
 */
const proJpnAdmitStep: FilterStep = {
  name: 'jpn-admit-pro',
  phase: 'admit-pro',
  evaluate({ tj, cache }): FilterVerdict {
    const proEntry = cache.proEnrichmentMap[tj];
    if (proEntry?.nationalcode === 'JPN') return { decision: 'admit', via: 'pro' };
    return { decision: 'pass' };
  },
};

/**
 * Step 5 — Per-artist JPN tag, lead-component-only (§2.B).
 *
 * CLAUDE.md gotcha: the "lead" is index 1 when splitArtistCollab produced ≥2
 * elements (index 0 is the whole string), else index 0. Featured-artist
 * components do NOT contribute to admission — that admit rule was the path that
 * leaked the `Charlie Puth(Feat.宇多田ヒカル)` case pre-fix.
 *
 * This is the PRIMARY confirmation path: per-record title-search historically
 * had high miss rates (33% in PR-1's pre-seed: 1,950 / 5,961 title-search
 * calls returned no `pro` match). The per-artist scan (`searchSong?strType=2`)
 * side-steps that gap and crucially admits Latin-titled Japanese acts
 * (GRANRODEO, halyosy, fripSide, …) where title-search returns nothing.
 */
const jpnAdmitStep: FilterStep = {
  name: 'jpn-admit-artist',
  phase: 'admit-artist',
  evaluate({ title, artist, components, cache }): FilterVerdict {
    if (components.length === 0) return { decision: 'pass' };
    const leadKey = leadKeyOf(components);
    if (leadKey === '') return { decision: 'pass' };
    if (isGenericAdmitBlocked(leadKey)) return { decision: 'pass' };
    const entry = cache.artistNationalityMap[leadKey];
    if (entry?.code === 'JPN') {
      // Filter-seam script guard (docs/ROADMAP.md "TJ filter seam"): when the
      // row itself reads as Korean script — Hangul present and no Japanese
      // script over `${title} ${artist}`, the #97-gate discriminator — the
      // artist verdict is a first-crawl leak. The lagging per-song `KOR`
      // nationalcode that would reject it at step 1 (non-jpn-pro-reject) is not
      // written until AFTER this classify pass, so the deny-list is today's only
      // defense and it needs a hand-maintained entry. Fall through instead of
      // admitting. NOTE: a vetoed row surfaces as `no-admit-path` in the
      // decision log unless a later step (blog-rescue, when force-listed)
      // decides it — the curated rescue path is deliberately preserved.
      // Genuine Hangul-glossed JP releases are unaffected: they admit upstream
      // via reviewed-song-allow (step 2, script-clean render) or jpn-admit-pro
      // (step 4), both of which run before this step.
      if (readsAsKoreanScript(`${title} ${artist}`)) return { decision: 'pass' };
      // Simplified-Chinese veto (classify-time promotion of the report-only
      // detector, docs/ROADMAP.md "TJ filter seam"): the SAME `hasSimplifiedOnlyHan`
      // predicate the post-crawl audit uses (single-sourced from @karaoke/search).
      // A Mandopop/Cantopop row mis-tagged JPN by the artist scan that carries a
      // curated PRC-simplified-only Han character over `${title} ${artist}` is a
      // first-crawl leak of the same class the Korean veto above catches. The
      // predicate is precision-calibrated (0 hits over the v22 corpus + baseline),
      // so any hit is high-signal; and it EXCLUDES shinjitai that equal PRC
      // simplifications (国 学 体 会 医 数 …), so genuine Japanese kanji/shinjitai
      // titles never false-veto here. Fall through instead of admitting; the outer
      // defenses (deny-list, post-crawl audit + crawl-PR report) stay unchanged.
      if (hasSimplifiedOnlyHan(`${title} ${artist}`)) return { decision: 'pass' };
      return { decision: 'admit', via: 'artist' };
    }
    return { decision: 'pass' };
  },
};

/**
 * Step 6 — Blog-whitelist rescue.
 *
 * CLAUDE.md gotcha: safety net for residual TJ-search index gaps. Already
 * gated by step 1's explicit non-JPN pro reject above. This is NOT dead code —
 * a high `admittedByRescue` count in KeepStats signals real JPN records the
 * searchSong index can't see. The blog adapter has been hand-validated for
 * 21k+ Japanese records over time, so a TJ# the blog already knows is JPN.
 */
const blogRescueStep: FilterStep = {
  name: 'blog-rescue',
  phase: 'rescue',
  evaluate({ tj, force, components }): FilterVerdict {
    if (isGenericAdmitBlocked(leadKeyOf(components))) return { decision: 'pass' };
    if (force?.has(tj)) return { decision: 'admit', via: 'rescue' };
    return { decision: 'pass' };
  },
};

// ---------------------------------------------------------------------------
// The ordered pipeline — DO NOT reorder (CLAUDE.md load-bearing order)
// ---------------------------------------------------------------------------

/**
 * AUTHORITATIVE filter step order (single source of truth — the file-top
 * docblock, parser.ts, and the drop-list modules all point here):
 *   0. reviewed-song-drop    — audited TJ-number false positives
 *   1. non-jpn-pro-reject    — explicit non-JPN pro overrides all admit paths
 *   2. reviewed-song-allow   — audited TJ-number K-pop Japanese releases
 *   3. drop-list-reject      — Korean/Chinese artist deny (any-component)
 *   4. jpn-admit-pro         — exact per-pro JPN admit
 *   5. jpn-admit-artist      — lead-component-only JPN admit
 *   6. blog-rescue           — safety net for TJ-search index gaps
 *
 * drop-list-reject (step 3) precedes the JPN admit paths (steps 4-6) so a
 * drop-listed Korean act with a JPN pro tag that is NOT curated into
 * reviewed-song-allow is rejected before jpn-admit-pro can admit it.
 *
 * This order is not enforced by comment alone: each step carries a `phase`
 * ({@link PHASE_ORDER}) and {@link assertPhaseOrder} runs at module load, so a
 * reorder of this array throws at import time.
 */
export const FILTER_STEPS: FilterStep[] = [
  reviewedSongDropStep,
  nonJpnProRejectStep,
  reviewedSongAllowStep,
  dropListRejectStep,
  proJpnAdmitStep,
  jpnAdmitStep,
  blogRescueStep,
];

/**
 * Structurally enforce the load-bearing chain order: every step's {@link
 * FilterStep.phase} must appear in non-decreasing {@link PHASE_ORDER} rank as
 * the array is traversed. A reorder that would (re)introduce a KPOP-leak class
 * bug — e.g. an admit phase sliding ahead of `deny-list` — trips this and
 * throws at module load, before any record is classified. Prose comments and
 * the array literal alone could not catch that; this can.
 *
 * Exported so tests can assert both the real chain passes and that a
 * deliberately reordered array is rejected.
 */
export function assertPhaseOrder(steps: readonly FilterStep[]): void {
  let prevRank = -1;
  let prevStep: FilterStep | undefined;
  for (const step of steps) {
    const rank = PHASE_ORDER.indexOf(step.phase);
    if (rank === -1) {
      throw new Error(
        `FILTER_STEPS phase check: step "${step.name}" has phase "${step.phase}" which is not in PHASE_ORDER [${PHASE_ORDER.join(' → ')}].`,
      );
    }
    if (rank < prevRank && prevStep !== undefined) {
      throw new Error(
        `FILTER_STEPS order violation: "${step.name}" (phase "${step.phase}") runs after "${prevStep.name}" (phase "${prevStep.phase}"), but "${step.phase}" must not precede "${prevStep.phase}" per PHASE_ORDER [${PHASE_ORDER.join(' → ')}]. The TJ filter chain order is load-bearing — see docs/PROJECT-KNOWLEDGE.md.`,
      );
    }
    prevRank = rank;
    prevStep = step;
  }
}

// Fail fast at import time if the pipeline is ever reordered out of policy.
assertPhaseOrder(FILTER_STEPS);

/**
 * Build a FilterContext from the raw classifyRecord parameters.
 * Computes `components` once (shared by drop-list + jpn-admit-artist steps).
 */
export function buildFilterContext(
  tj: string,
  title: string,
  artist: string,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): FilterContext {
  return { tj, title, artist, components: splitArtistCollab(artist), cache, force };
}
