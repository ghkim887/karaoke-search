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
 * Source artifact: 2026-06-09 JOYSOUND full-catalog FP/FN adjudication sweep
 * (decision-log + per-chunk agent verdicts). The ALLOW entries are the
 * K-pop/foreign Japanese-language releases recovered from the FN stream and
 * pinned at the exact song number.
 * Counts: allow=173, drop=2.
 *
 * 2026-06-10 (CHECKPOINT 1 spot-check): 3 entries removed from ALLOW —
 * `148140` (Super Star / ハン・スンヨン(KARA)), `153397` (トライアングル /
 * 東方神起), `735357` (ミチGO / G-DRAGON). All three are Korean-language
 * recordings with no genuine Japanese-market release, failing the owner
 * policy (Japanese-language/JP-exclusive release required for K-pop admits).
 *
 * 2026-06-12 (Layer-3 400-row precision audit): 2 DROP entries added. The
 * audit found 28 `admit-jp-detail` false positives; 26 are now vetoed by the
 * classifier's `洋楽` genre check, but these 2 carry NO `genreNames` at all,
 * so only an exact-number DROP can keep them out.
 *
 * 2026-06-12 (Layer-3 audit, owner-approved recall recovery): 1 ALLOW entry
 * added — `623552` (LEveL / SawanoHiroyuki[nZk]:TOMORROW X TOGETHER), the
 * Solo Leveling (俺だけレベルアップな件) anime OP by Japanese composer
 * Hiroyuki Sawano feat. K-pop group TXT. The TXT artist component trips the
 * `foreign-korean` gate; it was the ONLY recall loss among the 17,318 known
 * blog-sourced JOYSOUND numbers. Per owner policy, K-pop-adjacent Japanese
 * releases admit ONLY by exact-number curated ALLOW (decidedOn 2026-06-12).
 */

const REVIEWED_JOYSOUND_ALLOW_NUMBERS = [
  '102058',
  '108714',
  '119130',
  '119132',
  '119356',
  '119757',
  '127170',
  '128170',
  '129925',
  '136087',
  '136712',
  '137011',
  '138401',
  '139496',
  '139559',
  '145498',
  '146627',
  '156034',
  '160926',
  '169895',
  '176521',
  '178525',
  '196179',
  '20358',
  '27318',
  '29248',
  '29342',
  '29431',
  '29654',
  '29656',
  '31165',
  '314415',
  '314666',
  '315658',
  '31736',
  '32364',
  '423625',
  '425040',
  '428125',
  '430251',
  '432574',
  '436196',
  '436368',
  '436370',
  '436861',
  '437377',
  '437716',
  '438628',
  '439254',
  '441087',
  '442907',
  '444441',
  '444443',
  '444445',
  '444794',
  '445653',
  '446285',
  '446790',
  '446791',
  '449055',
  '485851',
  '485852',
  '486703',
  '487040',
  '490417',
  '493364',
  '493365',
  '493366',
  '493367',
  '493404',
  '494448',
  '494455',
  '494788',
  '500883',
  '611193',
  '611194',
  '612819',
  '613116',
  '613117',
  '613625',
  '614848',
  '615994',
  '618714',
  '619135',
  '619137',
  '620278',
  '623385',
  '623552',
  '625451',
  '625610',
  '628936',
  '629087',
  '629283',
  '632341',
  '632545',
  '634551',
  '636633',
  '636634',
  '638231',
  '641588',
  '643257',
  '643582',
  '644103',
  '671766',
  '673999',
  '674148',
  '674215',
  '674216',
  '675378',
  '675565',
  '675649',
  '675939',
  '681288',
  '681356',
  '682669',
  '683281',
  '684886',
  '685465',
  '689262',
  '691326',
  '696479',
  '696832',
  '718202',
  '720768',
  '720918',
  '721782',
  '722768',
  '722769',
  '722770',
  '722771',
  '722775',
  '722777',
  '722778',
  '723150',
  '723697',
  '723955',
  '724739',
  '725433',
  '726121',
  '728240',
  '728241',
  '728244',
  '728245',
  '729028',
  '729058',
  '730523',
  '730524',
  '730525',
  '730526',
  '731684',
  '732623',
  '732624',
  '732626',
  '732841',
  '736148',
  '736151',
  '736611',
  '737709',
  '83318',
  '85082',
  '86277',
  '90569',
  '91467',
  '918326',
  '91985',
  '93169',
  '93684',
  '93686',
  '93689',
  '94314',
  '94350',
  '94623',
  '94647',
] as const;

/**
 * Single reviewed JOYSOUND DROP entry — one hand-audited catalog row. Mirrors
 * `tj-media-direct/reviewedSongOverrides.ts`'s `ReviewedSongOverrideEntry`:
 * the metadata makes each verdict auditable without the original artifact.
 */
export interface ReviewedJoysoundOverrideEntry {
  /** Canonical (hyphen-stripped) JOYSOUND number — the same key shape `normalizeJoysoundNumberKey` produces. */
  selSongNo: string;
  /** Catalog title as recorded at audit time. */
  title: string;
  /** Catalog artist as recorded at audit time. */
  artist: string;
  /** Decision date (`YYYY-MM-DD`, UTC) — when the reviewer verdict was recorded. */
  decidedOn: string;
  /** Audit provenance + short rationale. */
  note?: string;
}

export const REVIEWED_JOYSOUND_DROP_ENTRIES: readonly ReviewedJoysoundOverrideEntry[] = [
  {
    selSongNo: '154010',
    title: 'KUNIN MO NA ANG LAHAT SA AKIN',
    artist: 'ANGELINE QUINTO',
    decidedOn: '2026-06-12',
    note: 'Layer-3 400-row precision audit FP: Tagalog OPM row admitted via admit-jp-detail (natively-Latin entry, empty foreign-name fields misread as genuine-JP); detail carries NO genreNames, so the 洋楽 veto cannot catch it.',
  },
  {
    selSongNo: '488568',
    title: 'Laila Main Laila',
    artist: 'Pawni Pandey',
    decidedOn: '2026-06-12',
    note: 'Layer-3 400-row precision audit FP: Bollywood Hindi row admitted via admit-jp-detail (natively-Latin entry, empty foreign-name fields misread as genuine-JP); detail carries NO genreNames, so the 洋楽 veto cannot catch it.',
  },
];

// Store normalized keys so lookups (which probe with `normalizeJoysoundNumberKey`)
// always match, even for a future hyphenated/whitespace entry.
const REVIEWED_JOYSOUND_ALLOW = new Set<string>(
  REVIEWED_JOYSOUND_ALLOW_NUMBERS.map((selSongNo) => normalizeJoysoundNumberKey(selSongNo)),
);
const REVIEWED_JOYSOUND_DROP = new Set<string>(
  REVIEWED_JOYSOUND_DROP_ENTRIES.map((entry) => normalizeJoysoundNumberKey(entry.selSongNo)),
);

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
