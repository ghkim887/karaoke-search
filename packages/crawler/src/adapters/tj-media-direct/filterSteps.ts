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

import type { SearchSongCache } from './cache.js';
import { isInChineseDropList } from './chineseArtistDropList.js';
import { isInDropList } from './koreanArtistDropList.js';
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
  /** Raw artist string from `indexSong`. */
  artist: string;
  /** Collab-split components (pre-computed once per record). */
  components: string[];
  /** Shared searchSong enrichment cache. */
  cache: SearchSongCache;
  /** Blog-whitelist TJ numbers for the rescue path (may be undefined). */
  force: ReadonlySet<string> | undefined;
}

export interface FilterStep {
  /** Stable name used as a key in KeepStats counters and for test assertions. */
  name: string;
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
  evaluate({ components, cache }): FilterVerdict {
    if (components.length === 0) return { decision: 'pass' };
    const lead = leadComponentOf(components);
    if (lead === undefined) return { decision: 'pass' };
    const leadKey = normalizeForMatch(lead);
    if (leadKey === '') return { decision: 'pass' };
    if (GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST.has(leadKey)) return { decision: 'pass' };
    const entry = cache.artistNationalityMap[leadKey];
    if (entry?.code === 'JPN') return { decision: 'admit', via: 'artist' };
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
  evaluate({ tj, force, components }): FilterVerdict {
    const lead = leadComponentOf(components);
    const leadKey = lead === undefined ? '' : normalizeForMatch(lead);
    if (leadKey !== '' && GENERIC_ARTIST_JPN_ADMIT_BLOCKLIST.has(leadKey)) {
      return { decision: 'pass' };
    }
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
 * Build a FilterContext from the raw classifyRecord parameters.
 * Computes `components` once (shared by drop-list + jpn-admit-artist steps).
 */
export function buildFilterContext(
  tj: string,
  artist: string,
  cache: SearchSongCache,
  force?: ReadonlySet<string>,
): FilterContext {
  return { tj, artist, components: splitArtistCollab(artist), cache, force };
}
