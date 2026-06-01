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

export function makeCharacterNgrams(value: string, n: 2 | 3): string[] {
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
