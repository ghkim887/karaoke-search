import { normalizeForMatch } from './normalize.js';

/**
 * Hand-curated drop list of known Korean acts that leak into the TJ-direct
 * pipeline despite their `nationalcode` / vote-tally signal.
 *
 * Why this exists (per spec §2.E, 2026-05-01):
 *   - The TJ catalog has cross-script naming for the same act
 *     (`방탄소년단` / `BTS` / `防弾少年団`). Each script form gets a separate
 *     `artistNationalityMap` key; voting one form `KOR` does NOT demote the
 *     others. Empirical hits at the time the spec was written:
 *       `방탄소년단` JPN 3/0/0 (via JPOP-chart bootstrap),
 *       `BTS` UNKNOWN 0/0/0,
 *       `防弾少年団` JPN 13/0/0.
 *   - The `verdictFromVotes` ratio rule (spec §2.A) requires KOR votes to
 *     fire. Until §2.F's KPOP-chart bootstrap seeds those, the kanji-script
 *     leakers stay JPN. The drop list catches them deterministically.
 *   - The collab-split lead-component rule (§2.B) admits records like
 *     `Charlie Puth(Feat.宇多田ヒカル)` only when the lead is JPN. The drop
 *     list applies the inverse rule: ANY component matching drops the record,
 *     so a featured BTS member sinks a Japanese-led collab too.
 *
 * Maintenance policy:
 *   - **3-month review cadence.** Re-probe every entry against
 *     `apps/web/public/data/tj-search-cache.json` and audit
 *     `apps/web/public/data/songs.json` for new K-pop leakers
 *     (`Hangul-only artist_primary` + `categories: ['jpop']`).
 *   - **Add an entry** when a new Korean act shows up in the JP market and is
 *     not caught by the §2.A threshold + §2.F vote sourcing. Required steps:
 *       (1) confirm Korean origin,
 *       (2) enumerate every cache variant (kanji, Hangul, Latin, katakana),
 *       (3) add a regression case to
 *           `packages/crawler/test/adapters/tj-media-direct/parser.test.ts`,
 *       (4) set `lastReviewed` to today's UTC date (`YYYY-MM-DD`).
 *   - **Bias toward keeping entries.** Removing a drop-list entry is only
 *     correct when the act has shifted to a Japan-only career and the
 *     ratio-rule signal alone keeps them honest.
 *
 * Hot-path performance: `DROP_KEY_SET` is built once at module load by
 * pre-normalizing every variant via `normalizeForMatch` (the same key shape
 * the parser uses). The parser hot path is then a single `Set.has()` per
 * collab component.
 */

/** Single drop-list entry — one canonical Korean act with all observed surface forms. */
export interface DropListEntry {
  /** Display name for log / PR-body output. Choose the most-common Latin form. */
  canonical: string;
  /** Every observed surface form: kanji, Hangul, Latin (any case), katakana. */
  variants: readonly string[];
  /**
   * Last review timestamp (`YYYY-MM-DD`, UTC). Bump this whenever an entry
   * is verified or its variants are updated. The 3-month review cadence
   * (see `Maintenance policy` above) reads this field — entries older than
   * 90 days are flagged by the regression test as candidates for re-probe.
   *
   * Fix D.1 (2026-05-01): added so the maintenance cadence is enforceable
   * via test rather than tribal knowledge. Initial value `2026-05-01` for
   * every existing entry — the seed-list audit done in Phase 1.
   */
  lastReviewed: string;
  /** Optional one-line note for maintainers. */
  note?: string;
}

/**
 * Seed list of confirmed Korean leakers (top-20+ from spec §2.E, 2026-05-01).
 *
 * Each entry's variants were probed against `tj-search-cache.json` at the time
 * the spec was written; the cache codes shown in the spec table are recorded
 * in the per-entry `note` where they shift the maintenance picture (e.g. a
 * variant currently mis-tagged JPN that the drop list overrides).
 */
export const DROP_LIST: readonly DropListEntry[] = [
  {
    canonical: 'BTS',
    variants: ['방탄소년단', 'BTS', '防弾少年団', '정국', 'SUGA of BTS'],
    lastReviewed: '2026-05-01',
    note: '`방탄소년단` JPN 3/0/0 + `防弾少年団` JPN 13/0/0 in pre-fix cache.',
  },
  {
    canonical: "Girls' Generation",
    variants: ['소녀시대', '少女時代', 'SNSD', "Girls' Generation", 'Girls Generation'],
    lastReviewed: '2026-05-01',
    note: '`少女時代` JPN 12/0/0 in pre-fix cache.',
  },
  {
    canonical: 'TVXQ',
    variants: ['동방신기', '東方神起', 'TVXQ', 'Tohoshinki'],
    lastReviewed: '2026-05-01',
    note: '`東方神起` JPN 30/0/0 in pre-fix cache — the largest single kanji-script leaker.',
  },
  {
    canonical: 'FT Island',
    variants: ['FT Island', 'FTISLAND', '에프티 아일랜드', '에프티아일랜드'],
    lastReviewed: '2026-05-01',
    note: '`ftisland` JPN 2/0/0 in pre-fix cache.',
  },
  {
    canonical: 'EXO-CBX',
    variants: ['EXO-CBX', 'EXO', '엑소', 'EXO-K', 'EXO-M'],
    lastReviewed: '2026-05-01',
    note: '`exo-cbx` JPN 3/0/0 in pre-fix cache (survives threshold on ratio 1.0).',
  },
  {
    canonical: 'SUPER JUNIOR',
    variants: ['SUPER JUNIOR', 'SUPERJUNIOR', '슈퍼주니어'],
    lastReviewed: '2026-05-01',
    note: '`superjunior` JPN 2/0/0 in pre-fix cache.',
  },
  {
    canonical: 'Red Velvet',
    variants: ['Red Velvet', '레드벨벳', '레드 벨벳'],
    lastReviewed: '2026-05-01',
    note: '`redvelvet` JPN 3/0/0 in pre-fix cache.',
  },
  {
    canonical: 'SHINee',
    variants: ['SHINee', 'SHINEE', '샤이니'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'BIGBANG',
    variants: ['BIGBANG', 'BIG BANG', '빅뱅'],
    lastReviewed: '2026-05-01',
    note: '`bigbang` JPN 9/0/0 in pre-fix cache.',
  },
  {
    canonical: 'TWICE',
    variants: ['TWICE', '트와이스'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'BLACKPINK',
    variants: ['BLACKPINK', 'BLACK PINK', '블랙핑크'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'Stray Kids',
    variants: ['Stray Kids', 'STRAYKIDS', '스트레이 키즈'],
    lastReviewed: '2026-05-01',
    note: '`straykids` JPN 3/0/0 in pre-fix cache.',
  },
  {
    canonical: 'IVE',
    variants: ['IVE', '아이브', 'IVE(아이브)'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'aespa',
    variants: ['aespa', '에스파'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'NewJeans',
    variants: ['NewJeans', '뉴진스'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'LE SSERAFIM',
    variants: ['LE SSERAFIM', 'Le Sserafim', '르세라핌'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'ENHYPEN',
    variants: ['ENHYPEN', '엔하이픈'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'SEVENTEEN',
    variants: ['SEVENTEEN', '세븐틴'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'AKMU',
    variants: ['AKMU', 'AKMU(악뮤)', '악동뮤지션'],
    lastReviewed: '2026-05-01',
    note: '`AKMU(악뮤)` 62 records via blog rescue in pre-fix corpus.',
  },
  {
    canonical: 'Park Hyo Shin',
    variants: ['박효신', 'Park Hyo Shin'],
    lastReviewed: '2026-05-01',
    note: '`박효신` JPN 4/0/0 — 88 records, the single biggest non-group leaker.',
  },
  {
    canonical: 'Lump',
    variants: ['램프', 'Lump'],
    lastReviewed: '2026-05-01',
    note: '`램프` 39 records in pre-fix corpus.',
  },
  {
    canonical: 'IU',
    variants: ['IU', '아이유'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'IZ*ONE',
    variants: ['IZ*ONE', 'IZONE', '아이즈원'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'NCT WISH',
    variants: ['NCT WISH', '엔시티 위시'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'KARA',
    variants: ['KARA', '카라'],
    lastReviewed: '2026-05-01',
  },
  {
    canonical: 'J-Walk',
    // Variants verified against tj-search-cache.json on 2026-05-01: only the
    // Latin form `j-walk` appears (5 entries — including `j-walk(feat.지조)`
    // / `j-walk(feat.팀버)` etc.). The Hangul (`제이워크`) and katakana
    // (`ジェイウォーク`) variants had 0 cache entries — speculation removed
    // per Fix 3 (don't bloat the drop set with unverified variants). Adding
    // `JWALK` (no hyphen) defensively for the common spaceless form.
    variants: ['J-Walk', 'JWALK'],
    lastReviewed: '2026-05-01',
    note: '`j-walk` JPN 1/0/0 in post-Phase-2 cache (false-positive) — 20 TJ records leaked. Cache has only Latin `j-walk` form (5 entries).',
  },
  {
    canonical: 'PLAVE',
    // Variants verified against tj-search-cache.json on 2026-05-01: only the
    // Latin form `plave` appears (4 entries — including `plave(feat.쏠)`
    // and `eunhoofplave`). The Hangul (`플레이브`) and katakana (`プレイヴ`)
    // variants had 0 cache entries — speculation removed per Fix 3.
    variants: ['PLAVE'],
    lastReviewed: '2026-05-01',
    note: '`plave` JPN 3/0/0 in post-Phase-2 cache (false-positive) — 30 TJ records leaked. Cache has only Latin `plave` form (4 entries).',
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
export const DROP_KEY_SET: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const entry of DROP_LIST) {
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
export function isInDropList(normalizedArtistKey: string): boolean {
  if (normalizedArtistKey === '') return false;
  return DROP_KEY_SET.has(normalizedArtistKey);
}
