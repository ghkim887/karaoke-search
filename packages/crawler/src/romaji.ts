import * as wanakana from 'wanakana';

/**
 * Hiragana / katakana / CJK ideographs / kana extension blocks. If any code
 * point in the post-NFKC string lands in this range, the title contains
 * Japanese script and a Hepburn romaji index entry is worthwhile.
 *
 * Note: the spec proposes `wanakana.isJapanese(NFKC(title))`. In practice
 * wanakana 5.x's `isJapanese` returns false for mixed Japanese+Latin titles
 * (it short-circuits on any unrecognized character), which conflicts with
 * the spec's worked example `needsRomaji('花に亡霊 (movie ver.)') === true`.
 * We resolve the ambiguity in favor of the worked example: any kana/kanji
 * presence triggers romaji generation.
 */
const JAPANESE_RE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿ｦ-ﾟ]/u;

/**
 * True iff the title (after NFKC) contains Japanese script and therefore
 * benefits from a Hepburn romaji index entry. Pure-Latin and fullwidth-Latin
 * titles return false (NFKC folds fullwidth Latin to ASCII).
 */
export function needsRomaji(title: string): boolean {
  return JAPANESE_RE.test(title.normalize('NFKC'));
}

/**
 * Hepburn romanization of `title` after NFKC. Crawler-side only; never shipped
 * to the client bundle.
 */
export function toRomaji(title: string): string {
  return wanakana.toRomaji(title.normalize('NFKC'));
}
