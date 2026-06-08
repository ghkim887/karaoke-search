import type { Category } from '@karaoke/schema';
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
 */
const KOREAN_ACT_PATTERNS: readonly RegExp[] = [
  /\b(?:aespa|BABYMONSTER|ENHYPEN|ITZY|IVE|NCT\s*DREAM|NCT\s*WISH|NMIXX|SEVENTEEN|STRAY\s*KIDS|ZEROBASEONE|BTS|BLACKPINK|TWICE|TOMORROW\s*X\s*TOGETHER|TXT|TREASURE|BIGBANG|2NE1|GFRIEND|SUPER\s*JUNIOR|RED\s*VELVET|MONSTA\s*X|MAMAMOO|GOT7|EXO|ATEEZ|Kep1er|BOYNEXTDOOR|KISS\s*OF\s*LIFE|SHINee|KARA)\b/i,
  /(?:東方神起|少女時代|エスパ|アイヴ|エンハイプン|エヌシーティー|ストレイキッズ|セブンティーン|チョンソミ|ニュージーンズ|ルセラフィム|ベイビーモンスター|ゼロベースワン|トゥワイス|ブラックピンク|トゥモローバイトゥギャザー|トレジャー|レッドベルベット|モンスタエックス|ママムー|ヨジャチング|スーパージュニア|ビッグバン|トゥエニィワン|エクソ|エイティーズ|ケプラー|ボーイネクストドア|キスオブライフ|ゴットセブン)/u,
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
}

/**
 * Which gate decided a JOYSOUND row. Admit reasons carry a non-null category;
 * the three `drop-*` reasons and `reviewed-drop` / `foreign-*` carry `null`.
 *
 *  - `reviewed-allow` / `reviewed-drop` — exact-number curated override hit.
 *  - `foreign-korean` / `foreign-western` — hard negative act gate.
 *  - `admit-vocaloid` / `admit-anime` / `admit-jpop-kana` — positive gates.
 *  - `drop-han-only` — title/artist has Han but no kana (Mandopop-ambiguous).
 *  - `drop-ascii-only` — title/artist is Latin-only, weak Japanese evidence.
 *  - `drop-no-signal` — neither Han, Latin, nor kana script.
 */
export type JoysoundClassifyReason =
  | 'reviewed-allow'
  | 'reviewed-drop'
  | 'foreign-korean'
  | 'foreign-western'
  | 'admit-vocaloid'
  | 'admit-anime'
  | 'admit-jpop-kana'
  | 'drop-han-only'
  | 'drop-ascii-only'
  | 'drop-no-signal';

const DEFAULT_OVERRIDES: JoysoundOverridePredicates = {
  isAllow: isReviewedJoysoundAllow,
  isDrop: isReviewedJoysoundDrop,
};

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
 * Drop (null):
 *   known Korean/Western-act alias, or no script signal and no token match.
 *   Examples: `Set The Tone / aespa`, `Chaconne / ENHYPEN`, `WE WILL ROCK YOU
 *   《LIVEカラオケ》 / QUEEN`, and katakana aliases like `チョンソミ`. These
 *   foreign rows would otherwise wrongly enter the JPop catalog.
 */
export function classifyJoysoundRecord(args: ClassifyArgs): Category | null {
  return classifyJoysoundRecordWithReason(args).category;
}

/**
 * Reason-rich classification: returns the resolved category alongside the gate
 * that fired. `classifyJoysoundRecord` delegates here and returns `.category`,
 * so the public `Category | null` contract — and the crawler that consumes it —
 * is unchanged.
 *
 * Order (mirrors TJ's allow-precedes-droplist policy):
 *   1. override DROP   → drop first, before any admit gate.
 *   2. override ALLOW  → admit before the foreign-act gate; picks the best
 *      normal-gate category, falling back to `jpop` when no signal fires.
 *   3. foreign-act gate (Korean / Western) → hard negative.
 *   4. positive gates: vocaloid > anime > jpop-kana.
 *   5. fall-through drop, split by script signal for diagnostic richness.
 */
export function classifyJoysoundRecordWithReason({
  listItem,
  detail,
  overrides = DEFAULT_OVERRIDES,
}: ClassifyArgs): { category: Category | null; reason: JoysoundClassifyReason } {
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
  if (overrides.isDrop(listItem.selSongNo)) return { category: null, reason: 'reviewed-drop' };

  // The best positive category from the normal gates, computed once so both the
  // ALLOW path (which keeps a real anime/vocaloid tag rather than forcing jpop)
  // and the normal cascade share it.
  const positiveCategory = positiveSignalCategory({ surface, artistSurface, titleArtist });

  // 2. Curated ALLOW override admits BEFORE the foreign-act gate.
  if (overrides.isAllow(listItem.selSongNo)) {
    return { category: positiveCategory ?? 'jpop', reason: 'reviewed-allow' };
  }

  // 3. Hard negative foreign-act gate.
  if (artistFields.some(isKnownKoreanAct)) return { category: null, reason: 'foreign-korean' };
  if (artistFields.some(isKnownWesternAct)) return { category: null, reason: 'foreign-western' };

  // 4. Positive gates.
  if (positiveCategory === 'vocaloid') return { category: 'vocaloid', reason: 'admit-vocaloid' };
  if (positiveCategory === 'anime') return { category: 'anime', reason: 'admit-anime' };
  if (positiveCategory === 'jpop') return { category: 'jpop', reason: 'admit-jpop-kana' };

  // 5. Fall-through drop — split by script signal for diagnostic richness.
  if (hasHanScript(titleArtist)) return { category: null, reason: 'drop-han-only' };
  if (hasAsciiLetter(titleArtist)) return { category: null, reason: 'drop-ascii-only' };
  return { category: null, reason: 'drop-no-signal' };
}

/**
 * The positive-signal category (vocaloid > anime > jpop) a row would earn,
 * independent of the foreign-act gate. Returns `null` when no positive signal
 * fires. Shared by the ALLOW path and the normal cascade so the two never
 * drift.
 */
function positiveSignalCategory(parts: {
  surface: string;
  artistSurface: string;
  titleArtist: string;
}): Category | null {
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
