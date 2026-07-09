/**
 * Deterministic, dependency-free, table-driven transliteration of Japanese kana
 * readings (JOYSOUND `title_ruby`, almost always pure katakana) into two
 * SEARCH-ONLY alphabets:
 *
 *   - {@link kanaToRomaji}  — modified Hepburn, plain lowercase ASCII.
 *   - {@link kanaToHangul}  — Korean phonetic transcription (국립국어원-style).
 *
 * Both exist so a kanji title with a known reading becomes findable by that
 * reading typed in kana ("マル"), Latin romaji ("maru"), or Hangul ("마루").
 * The outputs feed the search index (search_texts / search_tokens) and the web
 * MiniSearch config ONLY; they never mutate canonical data and never feed
 * crawler / classifier / admit / drop decisions.
 *
 * DESIGN — deliberate simplifications (documented so tests can pin them):
 *
 *   Shared:
 *     - Input is NFKC-normalized first, so half-width kana (ｶ), full-width Latin,
 *       and the half-width prolonged mark (ｰ) fold into the standard blocks
 *       before any table lookup.
 *     - Hiragana is folded to katakana (single lookup table) by the fixed
 *       U+3041–U+3096 → +0x60 code shift.
 *     - Non-kana characters never throw: romaji passes ASCII alphanumerics
 *       through (lowercased) and collapses everything else to a separator;
 *       hangul drops anything it cannot read (kanji, Latin, punctuation).
 *     - Iteration marks ヽ/ゝ repeat the previous mora; voiced ヾ/ゞ repeat it
 *       voiced when the previous kana has a voiced form, else unvoiced.
 *     - The katakana middle dot ・ becomes a separator (space).
 *
 *   Romaji (modified Hepburn):
 *     - 拗音 (youon, キャ→kya) and loanword digraphs (シェ→she, ファ→fa, ヴァ→va…)
 *       come from an explicit two-kana table.
 *     - 促音 (sokuon, ッ) doubles the next mora's leading consonant; before a
 *       "ch" mora it emits "t" (マッチ→matchi). A word-final ッ (nothing to
 *       double) is DROPPED.
 *     - 長音 (chōon, ー) repeats the preceding vowel as plain ASCII (キャリー→
 *       kyarii) — NOT a macron, because search wants pure ASCII. Vowel
 *       sequences are written literally (オウ→ou, エイ→ei), never macron-merged.
 *     - ン is always "n"; the Hepburn n'/apostrophe disambiguation (しんいち →
 *       shin'ichi) is omitted because it does not help token matching.
 *
 *   Hangul (국립국어원 일본어 표기법, loosened):
 *     - ONE fixed table: word-initial vs word-medial allophony (か→가 initial /
 *       카 medial) is SKIPPED. A single position-independent form is used, chosen
 *       so the voiced/voiceless contrast survives (カ→카 aspirated, ガ→가 plain),
 *       which discriminates readings better than the official initial-softening.
 *     - 促音 ッ attaches a ㅅ 받침 to the preceding syllable (ハッピー→핫피); if
 *       that syllable already carries a 받침, the sokuon is dropped.
 *     - 長音 ー is DROPPED (standard Korean convention: no long-vowel marking).
 *     - ン attaches a ㄴ 받침 to the preceding syllable; if that syllable already
 *       carries a 받침 (e.g. after a sokuon), a standalone ㄴ jamo is emitted.
 *     - ツ→쓰, ザ행→자즈제조, and loanword digraphs are best-effort approximations.
 */

const HIRAGANA_START = 0x3041;
const HIRAGANA_END = 0x3096;
const HIRAGANA_TO_KATAKANA_SHIFT = 0x60;

const SOKUON = 'ッ';
const CHOON = 'ー';
const MIDDLE_DOT = '・';
const ITERATION = 'ヽ';
const ITERATION_VOICED = 'ヾ';

/**
 * Hiragana iteration marks ゝ (U+309D) / ゞ (U+309E) sit just past the
 * U+3041–U+3096 fold range, so the +0x60 code-shift never reaches them. Map
 * them explicitly onto their katakana counterparts ヽ (U+30FD) / ヾ (U+30FE) so
 * {@link segment} repeats the previous mora exactly as it does for katakana.
 */
const HIRAGANA_ITERATION_MARKS: Record<string, string> = {
  ゝ: ITERATION,
  ゞ: ITERATION_VOICED,
};

/**
 * Katakana that gain a voiced (dakuten) form, used only to resolve the voiced
 * iteration mark ヾ against the preceding kana. Not a general voicing table.
 */
const VOICED_KANA: Record<string, string> = {
  カ: 'ガ',
  キ: 'ギ',
  ク: 'グ',
  ケ: 'ゲ',
  コ: 'ゴ',
  サ: 'ザ',
  シ: 'ジ',
  ス: 'ズ',
  セ: 'ゼ',
  ソ: 'ゾ',
  タ: 'ダ',
  チ: 'ヂ',
  ツ: 'ヅ',
  テ: 'デ',
  ト: 'ド',
  ハ: 'バ',
  ヒ: 'ビ',
  フ: 'ブ',
  ヘ: 'ベ',
  ホ: 'ボ',
  ウ: 'ヴ',
};

// --- Romaji tables ---------------------------------------------------------

/** Two-kana sequences (youon + loanword digraphs) → romaji. Checked first. */
const ROMAJI_DIGRAPHS: Record<string, string> = {
  キャ: 'kya',
  キュ: 'kyu',
  キョ: 'kyo',
  ギャ: 'gya',
  ギュ: 'gyu',
  ギョ: 'gyo',
  シャ: 'sha',
  シュ: 'shu',
  ショ: 'sho',
  シェ: 'she',
  ジャ: 'ja',
  ジュ: 'ju',
  ジョ: 'jo',
  ジェ: 'je',
  チャ: 'cha',
  チュ: 'chu',
  チョ: 'cho',
  チェ: 'che',
  ヂャ: 'ja',
  ヂュ: 'ju',
  ヂョ: 'jo',
  ニャ: 'nya',
  ニュ: 'nyu',
  ニョ: 'nyo',
  ヒャ: 'hya',
  ヒュ: 'hyu',
  ヒョ: 'hyo',
  ビャ: 'bya',
  ビュ: 'byu',
  ビョ: 'byo',
  ピャ: 'pya',
  ピュ: 'pyu',
  ピョ: 'pyo',
  ミャ: 'mya',
  ミュ: 'myu',
  ミョ: 'myo',
  リャ: 'rya',
  リュ: 'ryu',
  リョ: 'ryo',
  ティ: 'ti',
  トゥ: 'tu',
  ディ: 'di',
  ドゥ: 'du',
  テュ: 'tyu',
  デュ: 'dyu',
  ファ: 'fa',
  フィ: 'fi',
  フェ: 'fe',
  フォ: 'fo',
  フュ: 'fyu',
  ウィ: 'wi',
  ウェ: 'we',
  ウォ: 'wo',
  ヴァ: 'va',
  ヴィ: 'vi',
  ヴェ: 've',
  ヴォ: 'vo',
  ヴュ: 'vyu',
  ツァ: 'tsa',
  ツィ: 'tsi',
  ツェ: 'tse',
  ツォ: 'tso',
  イェ: 'ye',
  クァ: 'kwa',
  クィ: 'kwi',
  クェ: 'kwe',
  クォ: 'kwo',
  グァ: 'gwa',
  スィ: 'si',
  ズィ: 'zi',
};

/** Single-kana → romaji. */
const ROMAJI_MONOGRAPHS: Record<string, string> = {
  ア: 'a',
  イ: 'i',
  ウ: 'u',
  エ: 'e',
  オ: 'o',
  カ: 'ka',
  キ: 'ki',
  ク: 'ku',
  ケ: 'ke',
  コ: 'ko',
  サ: 'sa',
  シ: 'shi',
  ス: 'su',
  セ: 'se',
  ソ: 'so',
  タ: 'ta',
  チ: 'chi',
  ツ: 'tsu',
  テ: 'te',
  ト: 'to',
  ナ: 'na',
  ニ: 'ni',
  ヌ: 'nu',
  ネ: 'ne',
  ノ: 'no',
  ハ: 'ha',
  ヒ: 'hi',
  フ: 'fu',
  ヘ: 'he',
  ホ: 'ho',
  マ: 'ma',
  ミ: 'mi',
  ム: 'mu',
  メ: 'me',
  モ: 'mo',
  ヤ: 'ya',
  ユ: 'yu',
  ヨ: 'yo',
  ラ: 'ra',
  リ: 'ri',
  ル: 'ru',
  レ: 're',
  ロ: 'ro',
  ワ: 'wa',
  ヲ: 'o',
  ヰ: 'wi',
  ヱ: 'we',
  ン: 'n',
  ガ: 'ga',
  ギ: 'gi',
  グ: 'gu',
  ゲ: 'ge',
  ゴ: 'go',
  ザ: 'za',
  ジ: 'ji',
  ズ: 'zu',
  ゼ: 'ze',
  ゾ: 'zo',
  ダ: 'da',
  ヂ: 'ji',
  ヅ: 'zu',
  デ: 'de',
  ド: 'do',
  バ: 'ba',
  ビ: 'bi',
  ブ: 'bu',
  ベ: 'be',
  ボ: 'bo',
  パ: 'pa',
  ピ: 'pi',
  プ: 'pu',
  ペ: 'pe',
  ポ: 'po',
  ヴ: 'vu',
  // Small vowels standing alone (not consumed by a digraph) read as their vowel.
  ァ: 'a',
  ィ: 'i',
  ゥ: 'u',
  ェ: 'e',
  ォ: 'o',
  ャ: 'ya',
  ュ: 'yu',
  ョ: 'yo',
  ヮ: 'wa',
  // Small ka/ke (ヵヶ) used in counters/place names.
  ヵ: 'ka',
  ヶ: 'ke',
};

// --- Hangul tables ---------------------------------------------------------

/** Two-kana sequences → precomposed Hangul syllable. Checked first. */
const HANGUL_DIGRAPHS: Record<string, string> = {
  キャ: '캬',
  キュ: '큐',
  キョ: '쿄',
  ギャ: '갸',
  ギュ: '규',
  ギョ: '교',
  シャ: '샤',
  シュ: '슈',
  ショ: '쇼',
  シェ: '셰',
  ジャ: '자',
  ジュ: '주',
  ジョ: '조',
  ジェ: '제',
  チャ: '차',
  チュ: '추',
  チョ: '초',
  チェ: '체',
  ヂャ: '자',
  ヂュ: '주',
  ヂョ: '조',
  ニャ: '냐',
  ニュ: '뉴',
  ニョ: '뇨',
  ヒャ: '햐',
  ヒュ: '휴',
  ヒョ: '효',
  ビャ: '뱌',
  ビュ: '뷰',
  ビョ: '뵤',
  ピャ: '퍄',
  ピュ: '퓨',
  ピョ: '표',
  ミャ: '먀',
  ミュ: '뮤',
  ミョ: '묘',
  リャ: '랴',
  リュ: '류',
  リョ: '료',
  ティ: '티',
  トゥ: '투',
  ディ: '디',
  ドゥ: '두',
  テュ: '튜',
  デュ: '듀',
  ファ: '파',
  フィ: '피',
  フェ: '페',
  フォ: '포',
  フュ: '퓨',
  ウィ: '위',
  ウェ: '웨',
  ウォ: '워',
  ヴァ: '바',
  ヴィ: '비',
  ヴェ: '베',
  ヴォ: '보',
  ヴュ: '뷰',
  ツァ: '차',
  ツィ: '치',
  ツェ: '체',
  ツォ: '초',
  イェ: '예',
  クァ: '콰',
  クィ: '퀴',
  クェ: '퀘',
  クォ: '쿼',
  グァ: '과',
  スィ: '시',
  ズィ: '지',
};

/** Single-kana → precomposed Hangul syllable. */
const HANGUL_MONOGRAPHS: Record<string, string> = {
  ア: '아',
  イ: '이',
  ウ: '우',
  エ: '에',
  オ: '오',
  カ: '카',
  キ: '키',
  ク: '쿠',
  ケ: '케',
  コ: '코',
  サ: '사',
  シ: '시',
  ス: '스',
  セ: '세',
  ソ: '소',
  タ: '타',
  チ: '치',
  ツ: '쓰',
  テ: '테',
  ト: '토',
  ナ: '나',
  ニ: '니',
  ヌ: '누',
  ネ: '네',
  ノ: '노',
  ハ: '하',
  ヒ: '히',
  フ: '후',
  ヘ: '헤',
  ホ: '호',
  マ: '마',
  ミ: '미',
  ム: '무',
  メ: '메',
  モ: '모',
  ヤ: '야',
  ユ: '유',
  ヨ: '요',
  ラ: '라',
  リ: '리',
  ル: '루',
  レ: '레',
  ロ: '로',
  ワ: '와',
  ヲ: '오',
  ヰ: '이',
  ヱ: '에',
  ガ: '가',
  ギ: '기',
  グ: '구',
  ゲ: '게',
  ゴ: '고',
  ザ: '자',
  ジ: '지',
  ズ: '즈',
  ゼ: '제',
  ゾ: '조',
  ダ: '다',
  ヂ: '지',
  ヅ: '즈',
  デ: '데',
  ド: '도',
  バ: '바',
  ビ: '비',
  ブ: '부',
  ベ: '베',
  ボ: '보',
  パ: '파',
  ピ: '피',
  プ: '푸',
  ペ: '페',
  ポ: '포',
  ヴ: '부',
  ァ: '아',
  ィ: '이',
  ゥ: '우',
  ェ: '에',
  ォ: '오',
  ャ: '야',
  ュ: '유',
  ョ: '요',
  ヮ: '와',
  ヵ: '카',
  ヶ: '케',
};

// Hangul syllable-composition constants (U+AC00 block: 19 choseong x 21
// jungseong x 28 jongseong). Shared with index.ts (makeHangulInitials); defined
// here in the leaf module so index.ts imports them without a cycle.
export const HANGUL_SYLLABLE_BASE = 0xac00;
export const HANGUL_JUNGSEONG_COUNT = 21;
export const HANGUL_JONGSEONG_COUNT = 28;
const HANGUL_SYLLABLE_COUNT = 19 * HANGUL_JUNGSEONG_COUNT * HANGUL_JONGSEONG_COUNT;
/** Jongseong (받침) index in the 28-entry final-consonant list. */
const JONGSEONG_NIEUN = 4; // ㄴ
const JONGSEONG_SIOT = 19; // ㅅ
/** Standalone compatibility jamo, used when a 받침 cannot attach. */
const COMPAT_JAMO_NIEUN = 'ㄴ';

/** NFKC, then fold the hiragana block to katakana so one table serves both. */
function toKatakana(input: string): string {
  const normalized = input.normalize('NFKC');
  let result = '';
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= HIRAGANA_START && codePoint <= HIRAGANA_END) {
      result += String.fromCodePoint(codePoint + HIRAGANA_TO_KATAKANA_SHIFT);
    } else {
      result += HIRAGANA_ITERATION_MARKS[character] ?? character;
    }
  }
  return result;
}

/** Whether a completed syllable block has an empty 받침 (final consonant). */
function isBareHangulSyllable(syllable: string): boolean {
  if (syllable.length !== 1) {
    return false;
  }
  const offset = (syllable.codePointAt(0) ?? 0) - HANGUL_SYLLABLE_BASE;
  return offset >= 0 && offset < HANGUL_SYLLABLE_COUNT && offset % HANGUL_JONGSEONG_COUNT === 0;
}

/** Return `syllable` with `jongseong` attached (caller ensures it is bare). */
function withJongseong(syllable: string, jongseong: number): string {
  return String.fromCodePoint((syllable.codePointAt(0) ?? 0) + jongseong);
}

/** The trailing ASCII vowel of a romaji mora, for chōon (long-vowel) repeats. */
function lastVowel(romaji: string): string {
  const match = romaji.match(/[aeiou](?=[^aeiou]*$)/);
  return match === null ? '' : match[0];
}

/** Consonant prefix a preceding sokuon (ッ) prepends to `romaji`. */
function geminationPrefix(romaji: string): string {
  if (romaji.length === 0) {
    return '';
  }
  // Modified Hepburn: っ before a "ch" mora is written "t" (マッチ → matchi).
  if (romaji.startsWith('ch')) {
    return 't';
  }
  const first = romaji[0] as string;
  // A vowel-initial or ん mora has no consonant to geminate.
  return /[aeioun]/.test(first) ? '' : first;
}

interface Mora {
  /** The transliterated syllable (romaji string or single Hangul block). */
  value: string;
  /** The source katakana (for iteration-mark repeats). */
  source: string;
}

/**
 * Split a katakana string into morae plus control marks, resolving digraphs and
 * iteration marks against `table` (`consumed` says how many source chars each
 * step used). Shared by both renderers so their segmentation can never drift.
 */
function* segment(
  katakana: string,
  digraphs: Record<string, string>,
  monographs: Record<string, string>,
): Generator<
  { type: 'mora'; mora: Mora } | { type: 'sokuon' } | { type: 'choon' } | { type: 'sep' }
> {
  const characters = Array.from(katakana);
  let previousSource = '';
  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index] as string;
    if (current === SOKUON) {
      yield { type: 'sokuon' };
      continue;
    }
    if (current === CHOON) {
      yield { type: 'choon' };
      continue;
    }
    if (current === MIDDLE_DOT) {
      previousSource = '';
      yield { type: 'sep' };
      continue;
    }
    if (current === ITERATION || current === ITERATION_VOICED) {
      if (previousSource === '') {
        continue;
      }
      const repeated =
        current === ITERATION_VOICED
          ? (VOICED_KANA[previousSource] ?? previousSource)
          : previousSource;
      const value = monographs[repeated];
      if (value !== undefined) {
        previousSource = repeated;
        yield { type: 'mora', mora: { value, source: repeated } };
      }
      continue;
    }

    const next = characters[index + 1];
    if (next !== undefined) {
      const pair = current + next;
      const digraph = digraphs[pair];
      if (digraph !== undefined) {
        index += 1;
        previousSource = current;
        yield { type: 'mora', mora: { value: digraph, source: pair } };
        continue;
      }
    }

    const mono = monographs[current];
    if (mono !== undefined) {
      previousSource = current;
      yield { type: 'mora', mora: { value: mono, source: current } };
      continue;
    }

    // Non-kana: surface it as a mora carrying the raw character; each renderer
    // decides whether to keep or drop it.
    previousSource = '';
    yield { type: 'mora', mora: { value: '', source: current } };
  }
}

/**
 * Transliterate a (mostly katakana) reading to modified-Hepburn lowercase ASCII
 * romaji. Non-kana input never throws — see the module header for the rules.
 */
export function kanaToRomaji(input: string): string {
  const katakana = toKatakana(input);
  let result = '';
  let pendingSokuon = false;
  for (const token of segment(katakana, ROMAJI_DIGRAPHS, ROMAJI_MONOGRAPHS)) {
    if (token.type === 'sokuon') {
      pendingSokuon = true;
      continue;
    }
    if (token.type === 'choon') {
      // A stray sokuon before a long-vowel mark has nothing to double.
      pendingSokuon = false;
      result += lastVowel(result);
      continue;
    }
    if (token.type === 'sep') {
      pendingSokuon = false;
      result += ' ';
      continue;
    }
    const romaji = moraToRomaji(token.mora);
    if (romaji.length === 0) {
      pendingSokuon = false;
      continue;
    }
    if (pendingSokuon) {
      result += geminationPrefix(romaji);
      pendingSokuon = false;
    }
    result += romaji;
  }
  // A trailing/isolated sokuon (nothing to double) is dropped. Collapse the
  // separators the middle dot / passthrough produced into single spaces.
  return result.replace(/\s+/g, ' ').trim();
}

function moraToRomaji(mora: Mora): string {
  if (mora.value !== '') {
    return mora.value;
  }
  // Passthrough: keep ASCII alphanumerics (lowercased), drop everything else.
  const character = mora.source;
  return /^[A-Za-z0-9]$/.test(character) ? character.toLowerCase() : ' ';
}

/**
 * Transliterate a (mostly katakana) reading to a Korean phonetic Hangul string.
 * Non-kana input never throws — see the module header for the rules.
 */
export function kanaToHangul(input: string): string {
  const katakana = toKatakana(input);
  const parts: string[] = [];
  const attach = (jongseong: number, fallback: string): void => {
    const last = parts[parts.length - 1];
    if (last !== undefined && isBareHangulSyllable(last)) {
      parts[parts.length - 1] = withJongseong(last, jongseong);
    } else if (fallback !== '') {
      parts.push(fallback);
    }
  };
  for (const token of segment(katakana, HANGUL_DIGRAPHS, HANGUL_MONOGRAPHS)) {
    if (token.type === 'sokuon') {
      // 促音 → ㅅ 받침 on the previous syllable; dropped if none can take it.
      attach(JONGSEONG_SIOT, '');
      continue;
    }
    if (token.type === 'choon') {
      // 長音 is not marked in Korean transcription.
      continue;
    }
    if (token.type === 'sep') {
      parts.push(' ');
      continue;
    }
    if (token.mora.source === 'ン') {
      attach(JONGSEONG_NIEUN, COMPAT_JAMO_NIEUN);
      continue;
    }
    if (token.mora.value !== '') {
      parts.push(token.mora.value);
    }
    // Non-kana with no Hangul reading is dropped.
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}
