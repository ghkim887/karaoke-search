import { splitArtistCollab } from '../../clustering.js';
import { isInChineseDropList } from '../tj-media-direct/chineseArtistDropList.js';
import { isInDropList } from '../tj-media-direct/koreanArtistDropList.js';
import { normalizeForMatch } from '../tj-media-direct/normalize.js';
import { isReviewedJoysoundAllow, isReviewedJoysoundDrop } from './reviewedJoysoundOverrides.js';
import type { JoysoundDetail, JoysoundListItem } from './types.js';

/**
 * Voicebanks, producer cues, and project names that mark a record as
 * `vocaloid`. Keep free-text tokens narrow: the full JOYSOUND catalog contains
 * ordinary J-pop/Western rows with words like "flower", "MEGUMI", and
 * "TSUGUMI", so Latin voicebank names need artist-field boundaries/context.
 */
const VOCALOID_SURFACE_TOKENS: readonly string[] = [
  'VOCALOID',
  'vocaloid',
  'Vocaloid',
  'ボカロ',
  '初音ミク',
  '鏡音リン',
  '鏡音レン',
  '巡音ルカ',
  '可不',
  '重音テト',
  'プロジェクトセカイ',
];

const VOCALOID_ARTIST_PATTERNS: readonly RegExp[] = [
  /\b(?:MEIKO|KAITO|GUMI)\b/i,
  /\bfeat\.?\s*(?:v[._\s-]*)?flower\b/i,
  /\bv[._\s-]*flower\b/i,
];

/**
 * Anime signals — these tokens reliably indicate anime/特撮 tie-ups in the
 * JOYSOUND listing `tieupInfo` cell. The list is intentionally narrow:
 *  - `映画` (movie) is excluded — it covers live-action films too.
 *  - `主題歌` / `挿入歌` (theme/insert song) are excluded — they appear in
 *    movie and drama tie-ups and require anime/特撮/character context to
 *    be meaningful signals. Cases like `TVアニメ「X」主題歌` still fire via
 *    `アニメ` or `TVアニメ`.
 *  - Bare `OP` / `ED` are excluded for full-catalog safety: ASCII words like
 *    `OPEN` and artist names like `EDITH PIAF` otherwise trigger false anime
 *    positives. Cases like `TVアニメ「X」OP` still fire via `アニメ`.
 */
const ANIME_TOKENS: readonly string[] = [
  'アニメ',
  'TVアニメ',
  '劇場版',
  '特撮',
  'キャラクター',
  'CV:',
];

/**
 * Confirmed Korean-act aliases observed in JOYSOUND new-release artist fields.
 * These are checked before script-based J-pop admission because JOYSOUND
 * supplies Japanese kana ruby for foreign/K-pop songs too, and some Korean
 * acts are rendered in katakana on the public listing. Match only artist-like
 * fields so a Japanese row titled "SEVENTEEN" is not falsely dropped.
 *
 * Fix F1 (2026-06-09): kept in lock-step with the audit's `KOREAN_ACT_PATTERNS`
 * (`scripts/lib/corpus-audit-guardrails.mjs`) so the classifier no longer drifts
 * from `isAuditForeignAct`. The added entries (`BIG BANG`, `CORTIS`,
 * `FT ISLAND`, `IZ*ONE`, `LE SSERAFIM`, `PLAVE`, `防弾少年団`) are a substring
 * test on the full artist surface, which catches member/feat forms the
 * collab-splitter cannot — e.g. `イ・ホンギ from FTISLAND` (` from ` is not a
 * split delimiter anywhere in the codebase) still trips `FT\s*ISLAND`.
 */
const KOREAN_ACT_PATTERNS: readonly RegExp[] = [
  /\b(?:aespa|BABYMONSTER|BIG\s*BANG|CORTIS|ENHYPEN|FT\s*ISLAND|ITZY|IVE|IZ\*ONE|LE\s*SSERAFIM|NCT\s*DREAM|NCT\s*WISH|NMIXX|PLAVE|SEVENTEEN|STRAY\s*KIDS|ZEROBASEONE|BTS|BLACKPINK|TWICE|TOMORROW\s*X\s*TOGETHER|TXT|TREASURE|BIGBANG|2NE1|GFRIEND|SUPER\s*JUNIOR|RED\s*VELVET|MONSTA\s*X|MAMAMOO|GOT7|EXO|ATEEZ|Kep1er|BOYNEXTDOOR|KISS\s*OF\s*LIFE|SHINee|KARA)\b/i,
  /(?:防弾少年団|東方神起|少女時代|エスパ|アイヴ|エンハイプン|エヌシーティー|ストレイキッズ|セブンティーン|チョンソミ|ニュージーンズ|ルセラフィム|ベイビーモンスター|ゼロベースワン|トゥワイス|ブラックピンク|トゥモローバイトゥギャザー|トレジャー|レッドベルベット|モンスタエックス|ママムー|ヨジャチング|スーパージュニア|ビッグバン|トゥエニィワン|エクソ|エイティーズ|ケプラー|ボーイネクストドア|キスオブライフ|ゴットセブン)/u,
];

const WESTERN_ACT_COMPONENTS = new Set<string>([
  'ADELE',
  'ARIANA GRANDE',
  'BACKSTREET BOYS',
  'BILLIE EILISH',
  'BRUNO MARS',
  'CELINE DION',
  'COLDPLAY',
  'DUA LIPA',
  'ED SHEERAN',
  'HARRY STYLES',
  'JUSTIN BIEBER',
  'LADY GAGA',
  'OLIVIA RODRIGO',
  'QUEEN',
  'RIHANNA',
  'SABRINA CARPENTER',
  'TAYLOR SWIFT',
  'THE WEEKND',
  'セリーヌディオン',
  'バックストリートボーイズ',
  'レディーガガ',
]);

/** Hiragana (U+3040–U+309F). */
const RE_HIRAGANA = /[぀-ゟ]/;
/** Katakana including half-width (U+30A0–U+30FF, U+FF66–U+FF9F). */
const RE_KATAKANA = /[゠-ヿｦ-ﾟ]/;
/**
 * Han ideographs (CJK Unified, U+3400–U+9FFF). Used ONLY to disambiguate which
 * fall-through DROP reason a record gets (`drop-han-only` vs `drop-ascii-only`
 * vs `drop-no-signal`) — Han alone never admits, because Han-only fields are
 * ambiguous with the Chinese catalog rows in the JOYSOUND source.
 */
const RE_HAN = /[㐀-鿿]/u;
/** Any A–Z / a–z Latin letter — distinguishes Latin-only drops. */
const RE_ASCII_LETTER = /[A-Za-z]/;
function containsAny(haystack: string, tokens: readonly string[]): boolean {
  for (const t of tokens) {
    if (haystack.includes(t)) return true;
  }
  return false;
}

function matchesAny(haystack: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((re) => re.test(haystack));
}

function hasKanaScript(s: string): boolean {
  return RE_HIRAGANA.test(s) || RE_KATAKANA.test(s);
}

function hasHanScript(s: string): boolean {
  return RE_HAN.test(s);
}

function hasAsciiLetter(s: string): boolean {
  return RE_ASCII_LETTER.test(s);
}

function isKnownKoreanAct(surface: string): boolean {
  return KOREAN_ACT_PATTERNS.some((re) => re.test(surface));
}

function normalizeWesternActComponent(component: string): string {
  return component
    .normalize('NFKC')
    .replace(/[・･]/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toUpperCase();
}

function artistComponents(surface: string): string[] {
  return surface
    .split(/\s*(?:×|,|、|\(|\)|（|）|\bfeaturing\b|\bfeat\.?\b)\s*/iu)
    .map((part) => normalizeWesternActComponent(part))
    .filter((part) => part.length > 0);
}

function isKnownWesternAct(surface: string): boolean {
  return artistComponents(surface).some((part) => WESTERN_ACT_COMPONENTS.has(part));
}

/**
 * Production drop-list foreign-act detection (Fix F1, 2026-06-09).
 *
 * The classifier's own `KOREAN_ACT_PATTERNS` / `WESTERN_ACT_COMPONENTS` are
 * hand-maintained and were drifting from the audit's `isAuditForeignAct`, which
 * unions the TJ-chain production Korean + Chinese drop lists. The full-catalog
 * sweep found 140 admitted rows by 12 drop-listed foreign acts (S.H.E, TWINS,
 * BEYOND, IZ*ONE, FTISLAND, J-Walk, AKMU, F4, PLAVE, B.A.D, …) whose katakana
 * song titles fired `admit-jpop-kana`. To stop that drift the foreign-act gate
 * now ALSO consults the SAME production drop lists the TJ filter chain rejects
 * on (`isInDropList` / `isInChineseDropList`), using the SAME component split
 * (`splitArtistCollab`) + normalization (`normalizeForMatch`) as
 * `filterSteps.ts` step 3 — so a featured member (`J-Walk Feat.ウンジウォン`,
 * `イ・ホンギ from FTISLAND`) still sinks the row.
 */
function dropListForeignKind(surface: string): 'korean' | 'chinese' | null {
  for (const component of splitArtistCollab(surface)) {
    const key = normalizeForMatch(component);
    if (key === '') continue;
    if (isInDropList(key)) return 'korean';
    if (isInChineseDropList(key)) return 'chinese';
  }
  return null;
}

/**
 * Override-predicate seam. Defaults to the production `reviewedJoysoundOverrides`
 * predicates; tests inject stubs to exercise the ALLOW/DROP paths against the
 * (intentionally empty) production lists without duplicating classification
 * logic.
 */
export interface JoysoundOverridePredicates {
  isAllow: (selSongNo: string) => boolean;
  isDrop: (selSongNo: string) => boolean;
}

interface ClassifyArgs {
  listItem: JoysoundListItem;
  detail?: JoysoundDetail;
  overrides?: JoysoundOverridePredicates;
  /**
   * Injected recall seam (Fix F2, 2026-06-09). When supplied AND a row would
   * otherwise fall through to a `drop-*` reason (no kana/anime/vocaloid signal,
   * not a foreign act, not curated-dropped), a `true` result admits the row as
   * `jpop` with reason `admit-jp-artist`. Mirrors the existing `overrides`
   * seam: OPTIONAL and defaults to undefined, so `classifyJoysoundRecord` and
   * the production crawler are UNAFFECTED — the JP-artist admit path is opt-in,
   * wired only by the sweep layer from a corpus-derived artist set.
   */
  isKnownJapaneseArtist?: (artist: string) => boolean;
}

/**
 * Which gate decided a JOYSOUND row. The `admit-*` and `reviewed-allow` reasons
 * are ADMIT verdicts; the three `drop-*` reasons plus `reviewed-drop` /
 * `foreign-*` are DROP verdicts. The reason label is the FP/FN audit value — it
 * records WHY a row was admitted or dropped (the old jpop/anime/vocaloid signal
 * kinds survive in the `admit-*` labels even though the schema category
 * dimension was removed).
 *
 *  - `reviewed-allow` / `reviewed-drop` — exact-number curated override hit.
 *  - `foreign-korean` / `foreign-chinese` / `foreign-western` — hard negative
 *    act gate. `foreign-korean`/`foreign-chinese` fire from the production
 *    Korean / Chinese drop lists (and the classifier's own Korean patterns);
 *    `foreign-western` from the Western-act components.
 *  - `admit-vocaloid` / `admit-anime` / `admit-jpop-kana` — positive gates.
 *  - `admit-jp-artist` — admitted because an INJECTED known-Japanese-artist
 *    predicate matched a row that would otherwise drop for lack of a
 *    kana/anime/vocaloid signal. Sweep-layer-only: production injects nothing.
 *  - `drop-han-only` — title/artist has Han but no kana (Mandopop-ambiguous).
 *  - `drop-ascii-only` — title/artist is Latin-only, weak Japanese evidence.
 *  - `drop-no-signal` — neither Han, Latin, nor kana script.
 */
export type JoysoundClassifyReason =
  | 'reviewed-allow'
  | 'reviewed-drop'
  | 'foreign-korean'
  | 'foreign-chinese'
  | 'foreign-western'
  | 'admit-vocaloid'
  | 'admit-anime'
  | 'admit-jpop-kana'
  | 'admit-jp-artist'
  | 'drop-han-only'
  | 'drop-ascii-only'
  | 'drop-no-signal';

const DEFAULT_OVERRIDES: JoysoundOverridePredicates = {
  isAllow: isReviewedJoysoundAllow,
  isDrop: isReviewedJoysoundDrop,
};

/**
 * The positive-signal kind a row earns from the normal admit gates, in priority
 * order `vocaloid` > `anime` > `jpop` (kana), or `null` when no positive signal
 * fires. This is a LOCAL classifier concept — the surviving FP/FN audit signal
 * that drives the `admit-*` reason labels — NOT the removed schema `Category`
 * dimension. It never escapes this module; the public contract is a boolean
 * admit/drop plus a reason.
 */
type PositiveSignalKind = 'vocaloid' | 'anime' | 'jpop' | null;

/**
 * Conservatively classify a JOYSOUND new-release row.
 *
 * Priority:
 *   known foreign-act alias gate > `vocaloid` > `anime` > `jpop` > drop (`null`).
 *
 * Vocaloid:
 *   Japanese/project tokens can appear in full surface text. Latin voicebank
 *   tokens require artist-field boundaries/context so words like `MEGUMI`,
 *   `TSUGUMI`, or ordinary song titles containing `flower` are not promoted.
 *
 * Anime:
 *   any of `ANIME_TOKENS` appears in the full surface text. `映画` alone is
 *   NOT in the list (catches live-action films too).
 *
 * JPop:
 *   kana (hiragana / katakana) appears in songName / artistName. CJK
 *   ideographs alone are deliberately not enough: the JOYSOUND catalog is
 *   broad, and Han-only title/artist fields are ambiguous with Chinese catalog
 *   rows. `songNameRuby` is deliberately excluded from admission surfaces
 *   because JOYSOUND supplies kana ruby for foreign/K-pop rows too, and ruby
 *   for Latin words like `animation` can contain explicit-looking tokens such
 *   as `アニメーション` without proving an anime tie-up.
 *   tieupInfo and tieupNames are deliberately excluded from J-pop admission —
 *   a Latin-titled Latin-artist row with only `映画「X」` in tieup must not be
 *   promoted to jpop on the strength of one tieup-cell ideograph alone. Staff
 *   metadata is also excluded from admission because it does not identify the
 *   song itself.
 *
 * Drop (false):
 *   known Korean/Western-act alias, or no script signal and no token match.
 *   Examples: `Set The Tone / aespa`, `Chaconne / ENHYPEN`, `WE WILL ROCK YOU
 *   《LIVEカラオケ》 / QUEEN`, and katakana aliases like `チョンソミ`. These
 *   foreign rows would otherwise wrongly enter the catalog.
 */
export function classifyJoysoundRecord(args: ClassifyArgs): boolean {
  return classifyJoysoundRecordWithReason(args).admit;
}

/**
 * Reason-rich classification: returns the admit/drop verdict alongside the gate
 * that fired. `classifyJoysoundRecord` delegates here and returns `.admit`, so
 * the public boolean contract — and the crawler that consumes it — is unchanged.
 *
 * Order (mirrors TJ's allow-precedes-droplist policy):
 *   1. override DROP   → drop first, before any admit gate.
 *   2. override ALLOW  → admit before the foreign-act gate, reason
 *      `reviewed-allow`.
 *   3. foreign-act gate (Korean drop list / Korean patterns / Chinese drop list
 *      / Western) → hard negative. Consulting the production drop lists keeps
 *      this gate in lock-step with the audit's `isAuditForeignAct` (Fix F1).
 *   4. positive gates: vocaloid > anime > jpop-kana.
 *   5. injected known-Japanese-artist admit (Fix F2). Runs AFTER the foreign-act
 *      gate so a foreign act that also has corpus presence (e.g. BoA) stays
 *      dropped; opt-in only, no-op in production.
 *   6. fall-through drop, split by script signal for diagnostic richness.
 */
export function classifyJoysoundRecordWithReason({
  listItem,
  detail,
  overrides = DEFAULT_OVERRIDES,
  isKnownJapaneseArtist,
}: ClassifyArgs): { admit: boolean; reason: JoysoundClassifyReason } {
  const titleArtistParts: string[] = [listItem.songName, listItem.artistName];
  const surfaceParts: string[] = [listItem.songName, listItem.artistName, listItem.tieupInfo ?? ''];
  const artistFields: string[] = [listItem.artistName];
  if (detail) {
    surfaceParts.push(
      detail.songName,
      detail.artistName ?? '',
      ...detail.genreNames,
      ...detail.tieupNames,
    );
    titleArtistParts.push(detail.songName, detail.artistName ?? '');
    if (detail.artistName !== null) artistFields.push(detail.artistName);
  }
  const surface = surfaceParts.join(' ');
  const titleArtist = titleArtistParts.join(' ');
  const artistSurface = artistFields.join(' ');

  // 1. Curated DROP override wins first.
  if (overrides.isDrop(listItem.selSongNo)) return { admit: false, reason: 'reviewed-drop' };

  // The positive signal kind from the normal gates, computed once so both the
  // ALLOW path (whose reason is `reviewed-allow` regardless) and the normal
  // cascade (which maps the kind to its `admit-*` reason) share it.
  const positiveKind = positiveSignalKind({ surface, artistSurface, titleArtist });

  // 2. Curated ALLOW override admits BEFORE the foreign-act gate.
  if (overrides.isAllow(listItem.selSongNo)) {
    return { admit: true, reason: 'reviewed-allow' };
  }

  // 3. Hard negative foreign-act gate. The classifier's own Korean patterns +
  //    the production Korean drop list both resolve to `foreign-korean`; the
  //    production Chinese drop list resolves to `foreign-chinese` (Fix F1).
  if (artistFields.some(isKnownKoreanAct)) return { admit: false, reason: 'foreign-korean' };
  for (const field of artistFields) {
    const kind = dropListForeignKind(field);
    if (kind === 'korean') return { admit: false, reason: 'foreign-korean' };
    if (kind === 'chinese') return { admit: false, reason: 'foreign-chinese' };
  }
  if (artistFields.some(isKnownWesternAct)) return { admit: false, reason: 'foreign-western' };

  // 4. Positive gates.
  if (positiveKind === 'vocaloid') return { admit: true, reason: 'admit-vocaloid' };
  if (positiveKind === 'anime') return { admit: true, reason: 'admit-anime' };
  if (positiveKind === 'jpop') return { admit: true, reason: 'admit-jpop-kana' };

  // 5. Injected known-Japanese-artist admit (Fix F2). Opt-in recall path: a row
  //    with no positive script signal but a confirmed corpus JP artist admits.
  //    The foreign-act gate above already excluded foreign acts, so a predicate
  //    hit here is genuinely Japanese. No predicate → skipped, so the
  //    production classifier/crawler contract is unchanged.
  if (isKnownJapaneseArtist) {
    for (const field of artistFields) {
      if (field !== '' && isKnownJapaneseArtist(field)) {
        return { admit: true, reason: 'admit-jp-artist' };
      }
    }
  }

  // 6. Fall-through drop — split by script signal for diagnostic richness.
  if (hasHanScript(titleArtist)) return { admit: false, reason: 'drop-han-only' };
  if (hasAsciiLetter(titleArtist)) return { admit: false, reason: 'drop-ascii-only' };
  return { admit: false, reason: 'drop-no-signal' };
}

/**
 * The positive-signal kind (vocaloid > anime > jpop) a row would earn,
 * independent of the foreign-act gate. Returns `null` when no positive signal
 * fires. Shared by the ALLOW path and the normal cascade so the two never
 * drift.
 */
function positiveSignalKind(parts: {
  surface: string;
  artistSurface: string;
  titleArtist: string;
}): PositiveSignalKind {
  if (
    containsAny(parts.surface, VOCALOID_SURFACE_TOKENS) ||
    matchesAny(parts.artistSurface, VOCALOID_ARTIST_PATTERNS)
  ) {
    return 'vocaloid';
  }
  if (containsAny(parts.surface, ANIME_TOKENS)) return 'anime';
  if (hasKanaScript(parts.titleArtist)) return 'jpop';
  return null;
}
