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
