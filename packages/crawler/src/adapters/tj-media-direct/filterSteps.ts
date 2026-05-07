/**
 * Typed FilterStep[] reducer for the TJ-direct classifyRecord filter chain.
 *
 * CLAUDE.md gotcha: the filter chain ORDER IS LOAD-BEARING (spec §2.E / §2.C /
 * §2.B / per-pro JPN / blog-rescue). Do NOT reorder FILTER_STEPS.
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FilterVerdict =
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

// ---------------------------------------------------------------------------
// Step implementations (one per CLAUDE.md §2 filter chain step)
// ---------------------------------------------------------------------------

/**
 * Step 0 — Drop-list reject (any-component).
 *
 * CLAUDE.md gotcha (§2.E): Hand-curated Korean + Chinese (Cantopop/Mandopop)
 * acts that leak despite the cache signal. Applies to EVERY collab component
 * (inverse of Step 2's lead-only admit rule): a Japanese-led record featuring
 * SUGA of BTS still drops. This is the STRONGEST negative signal — it overrides
 * every admit path including the blog rescue.
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
 * Step 1 — Per-pro KOR-reject (§2.C).
 *
 * CLAUDE.md gotcha: an explicit KOR `nationalcode` from the searchSong
 * enrichment overrules every admit path (including the blog rescue). Defense
 * against TJ catalog metadata corrections that lag the blog corpus.
 */
const korRejectStep: FilterStep = {
  name: 'kor-reject',
  evaluate({ tj, cache }): FilterVerdict {
    const proEntry = cache.proEnrichmentMap[tj];
    if (proEntry?.nationalcode === 'KOR') return { decision: 'reject', reason: 'pro-kor' };
    return { decision: 'pass' };
  },
};

/**
 * Step 2 — Per-artist JPN tag, lead-component-only (§2.B).
 *
 * CLAUDE.md gotcha: the "lead" is index 1 when splitArtistCollab produced ≥2
 * elements (index 0 is the whole string), else index 0. Featured-artist
 * components do NOT contribute to admission — that admit rule was the path that
 * leaked the `Charlie Puth(Feat.宇多田ヒカル)` case pre-fix.
 */
const jpnAdmitStep: FilterStep = {
  name: 'jpn-admit-artist',
  evaluate({ components, cache }): FilterVerdict {
    if (components.length === 0) return { decision: 'pass' };
    const lead = components.length >= 2 ? components[1] : components[0];
    if (lead === undefined) return { decision: 'pass' };
    const leadKey = normalizeForMatch(lead);
    if (leadKey === '') return { decision: 'pass' };
    const entry = cache.artistNationalityMap[leadKey];
    if (entry?.code === 'JPN') return { decision: 'admit', via: 'artist' };
    return { decision: 'pass' };
  },
};

/**
 * Step 3 — Per-pro JPN tag.
 *
 * CLAUDE.md gotcha: catches the case where the artist scan was AMBIGUOUS or
 * UNKNOWN but the specific `pro` is JPN.
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
 * Step 4 — Blog-whitelist rescue.
 *
 * CLAUDE.md gotcha: safety net for residual TJ-search index gaps. Already
 * gated by step 1's KOR-reject above. This is NOT dead code — a high
 * `admittedByRescue` count in KeepStats signals real JPN records the
 * searchSong index can't see.
 */
const blogRescueStep: FilterStep = {
  name: 'blog-rescue',
  evaluate({ tj, force }): FilterVerdict {
    if (force?.has(tj)) return { decision: 'admit', via: 'rescue' };
    return { decision: 'pass' };
  },
};

// ---------------------------------------------------------------------------
// The ordered pipeline — DO NOT reorder (CLAUDE.md load-bearing order)
// ---------------------------------------------------------------------------

/**
 * Load-bearing filter step order per CLAUDE.md "TJ-direct filter chain" gotcha:
 *   0. drop-list-reject  — strongest negative signal, any-component
 *   1. kor-reject        — per-pro KOR overrides every admit path
 *   2. jpn-admit-artist  — lead-component-only JPN admit
 *   3. jpn-admit-pro     — per-pro JPN admit (catches AMBIGUOUS artists)
 *   4. blog-rescue       — safety net for TJ-search index gaps (NOT dead code)
 */
export const FILTER_STEPS: FilterStep[] = [
  dropListRejectStep,
  korRejectStep,
  jpnAdmitStep,
  proJpnAdmitStep,
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
