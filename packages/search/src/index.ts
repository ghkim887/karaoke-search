import { toHiragana, toKatakana, toRomaji } from 'wanakana';

export type KaraokeProvider = 'tj' | 'ky' | 'joysound';

export interface KaraokeNumberQuery {
  provider?: KaraokeProvider;
  number: string;
}

const SEARCH_WORD_PATTERN = /[\p{Letter}\p{Number}\p{Mark}]+/gu;
const KARAOKE_PROVIDER_PATTERN = /^(tj|ky|joysound)[\s:_-]*(\d[\d\s:_-]*)$/u;
const KARAOKE_NUMBER_PATTERN = /^\d[\d\s:_-]*$/u;

const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const HANGUL_CHOSEONG_START = 0x1100;
const HANGUL_CHOSEONG_END = 0x1112;
const HANGUL_JUNGSEONG_COUNT = 21;
const HANGUL_JONGSEONG_COUNT = 28;
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
    if (codePoint < HANGUL_SYLLABLE_START || codePoint > HANGUL_SYLLABLE_END) {
      continue;
    }

    const syllableOffset = codePoint - HANGUL_SYLLABLE_START;
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

const HIRAGANA_PATTERN = /[぀-ゟ]/u;
// Full-width katakana block (incl. the ー long-vowel mark) plus the phonetic
// extensions; half/full-width forms are folded to this block by NFKC first.
const KATAKANA_PATTERN = /[゠-ヿㇰ-ㇿ]/u;
// Any Han ideograph, including supplementary-plane extensions (e.g. 𠮟,
// U+20B9F) that the BMP-only ranges missed. Any kanji disqualifies a query
// from transliteration — we never generate kanji readings.
const KANJI_PATTERN = /\p{Script=Han}/u;
const LATIN_LETTER_PATTERN = /[A-Za-z]/u;

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

  // Detect on the NFKC form so width variants (half-width kana, full-width
  // Latin) classify the same way they index.
  const detect = original.normalize('NFKC');
  if (KANJI_PATTERN.test(detect)) {
    return variants;
  }

  const hasHiragana = HIRAGANA_PATTERN.test(detect);
  const hasKatakana = KATAKANA_PATTERN.test(detect);
  const hasLatin = LATIN_LETTER_PATTERN.test(detect);

  if ((hasHiragana || hasKatakana) && !hasLatin) {
    // Kana query → romaji recall variant (safe pure transliteration).
    push(toRomaji(original));
  } else if (hasLatin && !hasHiragana && !hasKatakana) {
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
  if (KANJI_PATTERN.test(detect)) {
    return null;
  }
  const hasHiragana = HIRAGANA_PATTERN.test(detect);
  const hasKatakana = KATAKANA_PATTERN.test(detect);
  const hasLatin = LATIN_LETTER_PATTERN.test(detect);
  if ((hasHiragana || hasKatakana) && !hasLatin) {
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
