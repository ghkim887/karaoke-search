import { toHiragana, toKatakana, toRomaji } from 'wanakana';
import {
  HANGUL_JONGSEONG_COUNT,
  HANGUL_JUNGSEONG_COUNT,
  HANGUL_SYLLABLE_BASE,
} from './transliterate.js';

export { kanaToHangul, kanaToRomaji } from './transliterate.js';

export type KaraokeProvider = 'tj' | 'ky' | 'joysound';

export interface KaraokeNumberQuery {
  provider?: KaraokeProvider;
  number: string;
}

/**
 * The kinds of rows in the `search_tokens` index. The builder writes tokens of
 * each kind and the query worker looks them up with an exact `(kind, token)`
 * JOIN, so this union is a shared contract: both sides MUST agree or matches
 * silently drop.
 */
export type SearchTokenKind = 'term' | 'prefix' | 'gram1' | 'gram2' | 'gram3' | 'initial';

/**
 * Per-provider bit set in a row's `provider_mask`, letting a search filter by
 * karaoke provider. Written into the index by the builder and combined into a
 * filter mask by the query worker; the two MUST use identical bits.
 */
export const PROVIDER_MASKS: Record<KaraokeProvider, number> = { tj: 1, ky: 2, joysound: 4 };

/**
 * Upper bound (in characters) on the prefix and initial tokens the index
 * builder emits and the query worker requests. Both sides MUST use the same
 * bound or the exact-match prefix JOIN loses recall on longer inputs.
 */
export const MAX_PREFIX_TOKEN_CHARS = 12;

const SEARCH_WORD_PATTERN = /[\p{Letter}\p{Number}\p{Mark}]+/gu;
const KARAOKE_PROVIDER_PATTERN = /^(tj|ky|joysound)[\s:_-]*(\d[\d\s:_-]*)$/u;
const KARAOKE_NUMBER_PATTERN = /^\d[\d\s:_-]*$/u;

const HANGUL_SYLLABLE_END = 0xd7a3;
const HANGUL_CHOSEONG_START = 0x1100;
const HANGUL_CHOSEONG_END = 0x1112;
const HANGUL_INITIALS = [
  'ㄱ',
  'ㄲ',
  'ㄴ',
  'ㄷ',
  'ㄸ',
  'ㄹ',
  'ㅁ',
  'ㅂ',
  'ㅃ',
  'ㅅ',
  'ㅆ',
  'ㅇ',
  'ㅈ',
  'ㅉ',
  'ㅊ',
  'ㅋ',
  'ㅌ',
  'ㅍ',
  'ㅎ',
] as const;

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und');
}

export function tokenizeSearchWords(value: string): string[] {
  return Array.from(normalizeSearchText(value).matchAll(SEARCH_WORD_PATTERN), (match) => match[0]);
}

export function compactSearchText(value: string): string {
  return tokenizeSearchWords(value).join('');
}

export function makeCharacterNgrams(value: string, n: 1 | 2 | 3): string[] {
  const characters = Array.from(compactSearchText(value));
  if (characters.length < n) {
    return [];
  }

  const grams: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index <= characters.length - n; index += 1) {
    const gram = characters.slice(index, index + n).join('');
    if (!seen.has(gram)) {
      seen.add(gram);
      grams.push(gram);
    }
  }

  return grams;
}

export function makeHangulInitials(value: string): string {
  const initials: string[] = [];
  for (const character of normalizeSearchText(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint >= HANGUL_CHOSEONG_START && codePoint <= HANGUL_CHOSEONG_END) {
      const initial = HANGUL_INITIALS[codePoint - HANGUL_CHOSEONG_START];
      if (initial !== undefined) {
        initials.push(initial);
      }
      continue;
    }
    if (codePoint < HANGUL_SYLLABLE_BASE || codePoint > HANGUL_SYLLABLE_END) {
      continue;
    }

    const syllableOffset = codePoint - HANGUL_SYLLABLE_BASE;
    const initialIndex = Math.floor(
      syllableOffset / (HANGUL_JUNGSEONG_COUNT * HANGUL_JONGSEONG_COUNT),
    );
    const initial = HANGUL_INITIALS[initialIndex];
    if (initial !== undefined) {
      initials.push(initial);
    }
  }

  return initials.join('');
}

export function normalizeKaraokeNumber(value: string): string {
  return Array.from(normalizeSearchText(value).matchAll(/\d/gu), (match) => match[0]).join('');
}

/**
 * Upper bound on the number of variants `expandSearchQuery` returns (original
 * included). Caps query fan-out so a single search never explodes into many
 * token sets. Romaji queries reach this bound (original + hiragana + katakana).
 */
const EXPANSION_VARIANT_LIMIT = 3;

/**
 * Upper bound (in code points) on a query `expandSearchQuery` will transliterate.
 * The wanakana transliterators (`toHiragana`/`toKatakana`/`toRomaji`) parse by
 * per-token recursion and overflow the call stack on pathological inputs (near
 * ~5-6k ASCII chars). No realistic karaoke query approaches this, so above the
 * bound the query is returned unchanged rather than fed to wanakana. The worker
 * rejects over-length `q` at the API edge too; this is the library-level guard
 * for every other caller.
 */
const MAX_EXPANDABLE_QUERY_CODE_POINTS = 256;

/**
 * Shared script-detection predicates — the single source for kana / Han /
 * Hangul / Latin discrimination consumed by this module AND the crawler
 * adapters (blog-whitelist trim, JP-likely rescue, JOYSOUND alias echo). They
 * historically lived as hand-copied per-adapter regexes with divergent ranges;
 * unified here (T1-3) to the widest correct range so a single string classifies
 * the same everywhere.
 *
 * `KANA_PATTERN` spans every kana form that appears in source text: the
 * Hiragana (U+3040–309F) and Katakana (U+30A0–30FF) blocks, the Katakana
 * Phonetic Extensions (U+31F0–31FF), and the half-width Katakana block
 * (U+FF66–FF9F, incl. the ｰ prolonged mark and ﾞ ﾟ sound marks). The half-width
 * forms matter only for callers that test raw (pre-NFKC) catalog text — callers
 * that normalize first never see them, and NFKC folds them into the blocks, so
 * their behaviour is unchanged.
 */
const KANA_PATTERN = /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]/u;
const KANA_ONLY_PATTERN = /^[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]+$/u;
// Any Han ideograph, including CJK extensions and supplementary-plane forms
// (e.g. 𠮟, U+20B9F) that BMP-only ranges miss.
const HAN_PATTERN = /\p{Script=Han}/u;
const HANGUL_PATTERN = /\p{Script=Hangul}/u;
const LATIN_LETTER_PATTERN = /[A-Za-z]/u;

/** Whether `value` contains any hiragana or katakana (any width). */
export function hasKana(value: string): boolean {
  return KANA_PATTERN.test(value);
}

/** Whether `value` is non-empty and composed ENTIRELY of kana (any width). */
export function isKanaOnly(value: string): boolean {
  return KANA_ONLY_PATTERN.test(value);
}

/** Whether `value` contains any Han ideograph (incl. extensions / supplementary plane). */
export function hasHan(value: string): boolean {
  return HAN_PATTERN.test(value);
}

/** Whether `value` contains any Hangul (syllables, jamo, or compatibility jamo). */
export function hasHangul(value: string): boolean {
  return HANGUL_PATTERN.test(value);
}

/** Whether `value` contains any A–Z / a–z Latin letter. */
export function hasLatinLetter(value: string): boolean {
  return LATIN_LETTER_PATTERN.test(value);
}

/** Whether `value` contains any non-ASCII character (code point above U+007F). */
export function hasNonAsciiCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

/**
 * Curated set of Han characters that appear ONLY in simplified-Chinese (PRC)
 * script — a high-precision signal that a row is Mandopop/Cantopop rather than
 * Japanese. This is the detector the ROADMAP "Chinese-leak detection" item calls
 * for: a broad `hasHan`-without-kana scan false-positives on the ~2k
 * kanji-titled Japanese songs in the corpus and is the WRONG tool, so instead we
 * key on characters Japanese never uses.
 *
 * CURATION RULE (precision over recall — a false-positive on a genuine Japanese
 * song is worse than a missed leak). Every character below is:
 *   1. a form used in simplified Chinese, AND
 *   2. NOT a valid Japanese kanji — not jōyō / jinmeiyō / common hyōgai, AND
 *   3. distinct (different code point) from BOTH the traditional form AND the
 *      Japanese shinjitai, which are what Japanese text actually uses.
 *
 * The load-bearing trap this set AVOIDS: many Japanese shinjitai were simplified
 * to the SAME glyph the PRC adopted (国 学 体 会 医 数 万 与 声 点 …). Those are
 * valid Japanese and are deliberately EXCLUDED — a Japanese title full of them
 * must NOT match. Only PRC simplifications Japan did not adopt are included.
 *
 * Each block is annotated with the Japanese counterpart form that proves the
 * simplified glyph is not used in Japanese (Japanese would write the counterpart
 * instead). Kept deliberately small and reviewable — a curated few-dozen
 * high-frequency characters, not an exhaustive Unihan dump.
 */
const SIMPLIFIED_ONLY_HAN_BLOCKS = [
  // Mandarin function words with no Japanese kanji counterpart at all:
  // 们 (plural marker), 这 (this; JA 這), 吗 (question particle; trad 嗎).
  '们这吗',
  // 言→讠 speech-radical simplifications (Japanese keeps the 言 radical):
  // 说説 语語 请請 谁誰 读読 谢謝 让譲 认認 论論 词詞 话話 讲講 议議 记記 该該.
  '说语请谁读谢让认论词话讲议记该',
  // 金→钅 metal-radical simplifications (Japanese keeps 金):
  // 钱銭 银銀 铁鉄 钟鐘 锁鎖.
  '钱银铁钟锁',
  // 門→门 gate-radical simplifications (Japanese keeps the full 門):
  // 门門 问問 间間 闻聞.
  '门问间闻',
  // Animal-radical simplifications distinct from the Japanese forms:
  // 马馬 鸟鳥 鱼魚 鸡鶏.
  '马鸟鱼鸡',
  // 見→见 / 頁→页 radical simplifications: 见見 观観 觉覚 题題.
  '见观觉题',
  // 糸→纟 silk-radical simplifications (Japanese keeps 糸): 红紅 给給 经経 结結.
  '红给经结',
  // Whole-character PRC simplifications whose Japanese counterpart (given after
  // each) is a DIFFERENT code point, so a Japanese title never contains these:
  // 爱愛 乐楽 龙竜 时時 电電 义義 习習 华華 汉漢 东東 车車 风風 飞飛 岁歳 应応 药薬
  // 图図 团団 单単 战戦 关関 边辺 过過 进進 运運 还還 长長 买買 卖売.
  '爱乐龙时电义习华汉东车风飞岁应药图团单战关边过进运还长买卖',
  // Common Chinese surname characters in their PRC-simplified form (a strong
  // artist-name leak signal), each distinct from the Japanese/traditional glyph:
  // 张張 陈陳 刘劉 郑鄭 邓鄧 赵趙 孙孫 韩韓.
  '张陈刘郑邓赵孙韩',
] as const;

/**
 * The curated simplified-Chinese-only Han characters as a lookup set (one
 * single-character string per code point). Frozen membership; see
 * {@link SIMPLIFIED_ONLY_HAN_BLOCKS} for the per-block curation rationale.
 */
export const SIMPLIFIED_ONLY_HAN: ReadonlySet<string> = new Set(
  Array.from(SIMPLIFIED_ONLY_HAN_BLOCKS.join('')),
);

/**
 * Whether `value` contains any curated simplified-Chinese-only Han character
 * (see {@link SIMPLIFIED_ONLY_HAN}). Precision-first leak signal (calibrated
 * 0 hits over the 313k v22 corpus) with three sanctioned consumers: the
 * report-only simplified-Chinese audit; the TJ `jpn-admit-artist` classify-time
 * veto (owner-approved 2026-07-13, fall-through `pass`, mirroring the
 * Korean-script seam guard); and the R5 KY (`ky-kysing`) classifier's
 * script-guard drop (owner-approved 2026-07-16 KY adapter spec). It must NOT
 * gate any other admit/drop path (in particular the JOYSOUND classifier)
 * without a fresh owner decision.
 */
export function hasSimplifiedOnlyHan(value: string): boolean {
  for (const character of value) {
    if (SIMPLIFIED_ONLY_HAN.has(character)) {
      return true;
    }
  }
  return false;
}

/**
 * Expand a free-text search query into safe transliteration variants for
 * recall, **without** generating kanji readings. Behaviour:
 *
 *   - A Latin/romaji query (e.g. `"yoru"`) yields hiragana + katakana variants
 *     (`"よる"`, `"ヨル"`) so it can match kana title/artist/alias text.
 *   - A kana query (e.g. `"よる"`) yields a romaji variant (`"yoru"`).
 *   - A query containing any kanji is returned unchanged — we do not romanize
 *     kanji, and a mixed kanji+kana query is left alone too.
 *   - Hangul / other scripts are returned unchanged.
 *
 * The original query is always the first (preferred) variant. Variants whose
 * `normalizeSearchText` form collides are deduplicated, and the result is
 * bounded by {@link EXPANSION_VARIANT_LIMIT}. A blank query yields `[]`.
 *
 * Transliteration is for SEARCH RECALL ONLY: the generated readings must never
 * feed crawler/classifier/admit/drop decisions or mutate canonical fields.
 */
export function expandSearchQuery(query: string): string[] {
  const original = query.trim();
  if (original.length === 0) {
    return [];
  }

  const variants: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const candidate = value.trim();
    if (candidate.length === 0) {
      return;
    }
    const key = normalizeSearchText(candidate);
    if (key.length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    variants.push(candidate);
  };

  push(original);

  // Guard wanakana against stack-overflowing on a pathologically long query
  // (see MAX_EXPANDABLE_QUERY_CODE_POINTS): above the bound, skip expansion and
  // return the original unchanged (the no-expansion result).
  if (Array.from(original).length > MAX_EXPANDABLE_QUERY_CODE_POINTS) {
    return variants;
  }

  // Detect on the NFKC form so width variants (half-width kana, full-width
  // Latin) classify the same way they index.
  const detect = original.normalize('NFKC');
  if (hasHan(detect)) {
    return variants;
  }

  const kana = hasKana(detect);
  const latin = hasLatinLetter(detect);

  if (kana && !latin) {
    // Kana query → romaji recall variant (safe pure transliteration).
    push(toRomaji(original));
  } else if (latin && !kana) {
    // Latin/romaji query → kana recall variants.
    push(toHiragana(original));
    push(toKatakana(original));
  }

  return variants.slice(0, EXPANSION_VARIANT_LIMIT);
}

/**
 * Derive a romaji search-recall variant from a kana (hiragana/katakana) string,
 * for indexing SEARCH-ONLY hint readings at build time. Returns `null` when the
 * input is not purely kana — anything containing kanji (we never generate kanji
 * readings here, mirroring {@link expandSearchQuery}) or Latin letters, or any
 * other script, yields `null` so callers only index safe pure transliterations.
 *
 * The derived romaji is for SEARCH RECALL ONLY: it must never feed
 * crawler/classifier/admit/drop decisions or mutate canonical fields.
 */
export function deriveKanaRomaji(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const detect = trimmed.normalize('NFKC');
  if (hasHan(detect)) {
    return null;
  }
  if (hasKana(detect) && !hasLatinLetter(detect)) {
    const romaji = toRomaji(trimmed).trim();
    return romaji.length > 0 ? romaji : null;
  }
  return null;
}

export function parseKaraokeNumberQuery(value: string): KaraokeNumberQuery | null {
  const normalized = normalizeSearchText(value).trim();
  if (normalized.length === 0) {
    return null;
  }

  const providerMatch = KARAOKE_PROVIDER_PATTERN.exec(normalized);
  if (providerMatch !== null) {
    const provider = providerMatch[1] as KaraokeProvider;
    const number = normalizeKaraokeNumber(providerMatch[2] ?? '');
    return number.length > 0 ? { provider, number } : null;
  }

  if (KARAOKE_NUMBER_PATTERN.test(normalized)) {
    const number = normalizeKaraokeNumber(normalized);
    return number.length > 0 ? { number } : null;
  }

  return null;
}
