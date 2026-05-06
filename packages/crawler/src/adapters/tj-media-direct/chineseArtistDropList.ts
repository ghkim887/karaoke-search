import { normalizeForMatch } from './normalize.js';

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
 *           `packages/crawler/test/adapters/tj-media-direct/parser.test.ts`.
 *
 * Hot-path performance: `CHINESE_ARTIST_DROP_LIST` is a `ReadonlySet<string>`
 * built once at module load. The parser hot path is a single `Set.has()` per
 * collab component. Lookups are EXACT-MATCH (no normalization beyond what the
 * parser already applies via `normalizeForMatch`); the variants below are
 * pre-normalized at module load.
 */

/**
 * Raw seed list of Cantopop / Mandopop artist surface forms observed in the
 * leaked corpus (2026-05-06 audit). Case-sensitive observed variants are all
 * listed — `BEYOND` / `Beyond` / `beyond`, `Twins` / `twins` / `TWINS` —
 * because the audit fixed-point caught all three of each on different records.
 *
 * Pre-normalized at module load via `normalizeForMatch` (the parser's hot-path
 * key shape) so the lookup is a single `Set.has()` per collab component.
 */
const CHINESE_ARTIST_DROP_LIST_RAW: readonly string[] = [
  'BEYOND',
  'Beyond',
  'beyond',
  'F4',
  'S.H.E',
  'Twins',
  'twins',
  'TWINS',
  'R1SE',
  'B.A.D',
  'F.I.R.',
  'Marry-M',
  'NZBZ',
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
  for (const variant of CHINESE_ARTIST_DROP_LIST_RAW) {
    const key = normalizeForMatch(variant);
    if (key !== '') set.add(key);
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
