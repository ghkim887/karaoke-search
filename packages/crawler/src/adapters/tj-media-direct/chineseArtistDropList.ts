import type { DropListEntry } from './koreanArtistDropList.js';
import { normalizeForMatch } from './normalize.js';

// Re-export the shared type so callers can import it from here without
// reaching into the Korean module directly.
export type { DropListEntry };

/**
 * Hand-curated drop list of Cantopop / Mandopop artists incorrectly tagged as
 * JPOP by TJ. Reject these in `classifyRecord` (parser.ts) so they never
 * enter the corpus.
 *
 * Why this exists:
 *   - The TJ Media catalog includes ~38 Chinese-language records (Cantopop,
 *     Mandopop) that are tagged `categories: ['jpop']` in the source. They
 *     pollute the J-pop corpus until something rejects them.
 *   - Unlike the Korean-leak family, these acts have NO Japan presence: the
 *     vote-tally signal in `tj-search-cache.json` cannot demote them because
 *     they don't show up on the JPOP-chart bootstrap or the KPOP-chart
 *     bootstrap. The drop list is the only deterministic gate.
 *   - The drop list runs at the same site as the Korean drop list
 *     (`classifyRecord` step 0) — any-component scan, applied BEFORE every
 *     admit path including the blog rescue.
 *
 * Schema: `DropListEntry` (same as `koreanArtistDropList.ts`) — shared type,
 * not duplicated. Each entry has `canonical` (primary display name), `variants`
 * (all observed surface forms), `lastReviewed` (ISO date, 3-month cadence),
 * and an optional `note`.
 *
 * Maintenance policy:
 *   - **Bias toward keeping entries.** Removing an entry is only correct when
 *     the act has shifted to a Japan-only career.
 *   - **Add an entry** when a new Cantopop / Mandopop act shows up in the
 *     corpus with `categories: ['jpop']`. Required steps:
 *       (1) confirm Chinese-language origin,
 *       (2) enumerate every observed surface form (the corpus shows BEYOND in
 *           three cases, Twins in three cases — the case-sensitive Set means
 *           every variant must be listed explicitly),
 *       (3) add a regression case to
 *           `packages/crawler/test/adapters/tj-media-direct/parser.test.ts`,
 *       (4) set `lastReviewed` to today's UTC date (`YYYY-MM-DD`).
 *   - **3-month review cadence.** Re-probe every entry against
 *     `apps/web/public/data/tj-search-cache.json`. Bump `lastReviewed` after
 *     each probe. Initial review date `2026-05-08` set during the structured-
 *     schema promotion (architect audit finding M2, 2026-05-08).
 *
 * Hot-path performance: `CHINESE_ARTIST_DROP_LIST` is a `ReadonlySet<string>`
 * built once at module load. The parser hot path is a single `Set.has()` per
 * collab component. Lookups are EXACT-MATCH on pre-normalized keys.
 */

/**
 * Seed list of confirmed Cantopop / Mandopop leakers (2026-05-06 audit,
 * structured schema added 2026-05-08).
 *
 * Case variants (BEYOND / Beyond / beyond, Twins / twins / TWINS) are all
 * listed because the audit fixed-point caught all three of each on different
 * TJ records. They collapse to the same normalized key at lookup time, but
 * the `variants` array documents exactly what was observed in the wild.
 */
export const CHINESE_DROP_LIST: readonly DropListEntry[] = [
  {
    canonical: 'BEYOND',
    variants: ['BEYOND', 'Beyond', 'beyond'],
    lastReviewed: '2026-05-08',
    note: 'Hong Kong rock band. Three case-sensitive variants observed on different TJ records (2026-05-06 audit).',
  },
  {
    canonical: 'F4',
    variants: ['F4'],
    lastReviewed: '2026-05-08',
    note: 'Taiwanese Mandopop group (Meteor Garden tie-in). Single observed surface form.',
  },
  {
    canonical: 'S.H.E',
    variants: ['S.H.E'],
    lastReviewed: '2026-05-08',
    note: 'Taiwanese Mandopop girl group.',
  },
  {
    canonical: 'Twins',
    variants: ['Twins', 'twins', 'TWINS'],
    lastReviewed: '2026-05-08',
    note: 'Cantopop duo. Three case-sensitive variants observed (2026-05-06 audit).',
  },
  {
    canonical: 'R1SE',
    variants: ['R1SE'],
    lastReviewed: '2026-05-08',
    note: 'Chinese boy group (Idol Producer 2019).',
  },
  {
    canonical: 'B.A.D',
    variants: ['B.A.D'],
    lastReviewed: '2026-05-08',
    note: 'Chinese act. Observed in leaked corpus records.',
  },
  {
    canonical: 'F.I.R.',
    variants: ['F.I.R.'],
    lastReviewed: '2026-05-08',
    note: 'Taiwanese Mandopop band (Fairyland In Reality).',
  },
  {
    canonical: 'Marry-M',
    variants: ['Marry-M'],
    lastReviewed: '2026-05-08',
    note: 'Chinese act. Observed in leaked corpus records.',
  },
  {
    canonical: 'NZBZ',
    variants: ['NZBZ'],
    lastReviewed: '2026-05-08',
    note: 'Chinese act (牛仔很忙组合). Observed in leaked corpus records.',
  },
];

/**
 * Pre-normalized lookup set. Built ONCE at module load via `normalizeForMatch`
 * so the parser hot path is a single `Set.has()` per collab component.
 *
 * Empty-after-normalize variants (none expected today, but defensive) are
 * skipped — they would be a false-positive on any artist with no normalizable
 * characters.
 */
export const CHINESE_ARTIST_DROP_LIST: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const entry of CHINESE_DROP_LIST) {
    for (const variant of entry.variants) {
      const key = normalizeForMatch(variant);
      if (key !== '') set.add(key);
    }
  }
  return set;
})();

/**
 * Drop-list membership check. Input MUST already be normalized via
 * `normalizeForMatch` — the parser hot path normalizes the artist component
 * once per call regardless, so we don't re-normalize here.
 */
export function isInChineseDropList(normalizedArtistKey: string): boolean {
  if (normalizedArtistKey === '') return false;
  return CHINESE_ARTIST_DROP_LIST.has(normalizedArtistKey);
}
