import type { JoysoundDetail, JoysoundListItem } from './types.js';

/**
 * Voicebanks, producer cues, and project names that are a positive JP-relevance
 * admit signal. Keep free-text tokens narrow: the full JOYSOUND catalog
 * contains ordinary J-pop/Western rows with words like "flower", "MEGUMI", and
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
 * JOYSOUND listing `tieupInfo` cell and are a positive JP-relevance admit
 * signal. The list is intentionally narrow:
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

interface ClassifyArgs {
  listItem: JoysoundListItem;
  detail?: JoysoundDetail;
}

/**
 * Conservatively decide whether to ADMIT a JOYSOUND new-release row into the
 * corpus. Returns `true` to admit, `false` to drop.
 *
 * Foreign-act drop gate (checked first):
 *   a known Korean/Western-act alias on an artist field drops the row.
 *   Examples: `Set The Tone / aespa`, `Chaconne / ENHYPEN`, `WE WILL ROCK YOU
 *   《LIVEカラオケ》 / QUEEN`, and katakana aliases like `チョンソミ`. These
 *   foreign rows would otherwise wrongly enter the catalog.
 *
 * Positive admit signals (any one admits):
 *   - A vocaloid voicebank/project token in the surface text, OR a vocaloid
 *     artist-field pattern. Japanese/project tokens can appear in full surface
 *     text; Latin voicebank tokens require artist-field boundaries/context so
 *     words like `MEGUMI`, `TSUGUMI`, or ordinary titles containing `flower`
 *     are not promoted.
 *   - An anime/特撮 token (`ANIME_TOKENS`) in the surface text. `映画` alone is
 *     NOT in the list (catches live-action films too).
 *   - kana (hiragana / katakana) in songName / artistName. CJK ideographs
 *     alone are deliberately not enough: the JOYSOUND catalog is broad, and
 *     Han-only title/artist fields are ambiguous with Chinese catalog rows.
 *     `songNameRuby` is deliberately excluded because JOYSOUND supplies kana
 *     ruby for foreign/K-pop rows too, and ruby for Latin words like
 *     `animation` can contain tokens such as `アニメーション` without proving a
 *     tie-up. tieupInfo/tieupNames and staff metadata are excluded from the
 *     kana admit surface — a Latin-titled Latin-artist row with only `映画「X」`
 *     in tieup must not be admitted on one tieup-cell ideograph alone.
 *
 * Drop (false):
 *   known Korean/Western-act alias, or no positive signal at all.
 */
export function classifyJoysoundRecord({ listItem, detail }: ClassifyArgs): boolean {
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

  if (artistFields.some(isKnownKoreanAct) || artistFields.some(isKnownWesternAct)) return false;
  if (
    containsAny(surface, VOCALOID_SURFACE_TOKENS) ||
    matchesAny(artistSurface, VOCALOID_ARTIST_PATTERNS)
  ) {
    return true;
  }
  if (containsAny(surface, ANIME_TOKENS)) return true;
  if (hasKanaScript(titleArtist)) return true;
  return false;
}
