import { describe, expect, it } from 'vitest';
import { kanaToHangul, kanaToRomaji } from '../src/transliterate.js';

/**
 * Every row is asserted with an INDEPENDENTLY written expected value (not copied
 * from the module tables), so a single wrong table entry — a mutated romaji
 * string or hangul syllable — fails a test. `[katakana, romaji, hangul]`.
 */
const MONOGRAPHS: Array<[string, string, string]> = [
  ['ア', 'a', '아'],
  ['イ', 'i', '이'],
  ['ウ', 'u', '우'],
  ['エ', 'e', '에'],
  ['オ', 'o', '오'],
  ['カ', 'ka', '카'],
  ['キ', 'ki', '키'],
  ['ク', 'ku', '쿠'],
  ['ケ', 'ke', '케'],
  ['コ', 'ko', '코'],
  ['サ', 'sa', '사'],
  ['シ', 'shi', '시'],
  ['ス', 'su', '스'],
  ['セ', 'se', '세'],
  ['ソ', 'so', '소'],
  ['タ', 'ta', '타'],
  ['チ', 'chi', '치'],
  ['ツ', 'tsu', '쓰'],
  ['テ', 'te', '테'],
  ['ト', 'to', '토'],
  ['ナ', 'na', '나'],
  ['ニ', 'ni', '니'],
  ['ヌ', 'nu', '누'],
  ['ネ', 'ne', '네'],
  ['ノ', 'no', '노'],
  ['ハ', 'ha', '하'],
  ['ヒ', 'hi', '히'],
  ['フ', 'fu', '후'],
  ['ヘ', 'he', '헤'],
  ['ホ', 'ho', '호'],
  ['マ', 'ma', '마'],
  ['ミ', 'mi', '미'],
  ['ム', 'mu', '무'],
  ['メ', 'me', '메'],
  ['モ', 'mo', '모'],
  ['ヤ', 'ya', '야'],
  ['ユ', 'yu', '유'],
  ['ヨ', 'yo', '요'],
  ['ラ', 'ra', '라'],
  ['リ', 'ri', '리'],
  ['ル', 'ru', '루'],
  ['レ', 're', '레'],
  ['ロ', 'ro', '로'],
  ['ワ', 'wa', '와'],
  ['ヲ', 'o', '오'],
  ['ヰ', 'wi', '이'],
  ['ヱ', 'we', '에'],
  ['ガ', 'ga', '가'],
  ['ギ', 'gi', '기'],
  ['グ', 'gu', '구'],
  ['ゲ', 'ge', '게'],
  ['ゴ', 'go', '고'],
  ['ザ', 'za', '자'],
  ['ジ', 'ji', '지'],
  ['ズ', 'zu', '즈'],
  ['ゼ', 'ze', '제'],
  ['ゾ', 'zo', '조'],
  ['ダ', 'da', '다'],
  ['ヂ', 'ji', '지'],
  ['ヅ', 'zu', '즈'],
  ['デ', 'de', '데'],
  ['ド', 'do', '도'],
  ['バ', 'ba', '바'],
  ['ビ', 'bi', '비'],
  ['ブ', 'bu', '부'],
  ['ベ', 'be', '베'],
  ['ボ', 'bo', '보'],
  ['パ', 'pa', '파'],
  ['ピ', 'pi', '피'],
  ['プ', 'pu', '푸'],
  ['ペ', 'pe', '페'],
  ['ポ', 'po', '포'],
  ['ヴ', 'vu', '부'],
  ['ァ', 'a', '아'],
  ['ィ', 'i', '이'],
  ['ゥ', 'u', '우'],
  ['ェ', 'e', '에'],
  ['ォ', 'o', '오'],
  ['ャ', 'ya', '야'],
  ['ュ', 'yu', '유'],
  ['ョ', 'yo', '요'],
  ['ヮ', 'wa', '와'],
  ['ヵ', 'ka', '카'],
  ['ヶ', 'ke', '케'],
];

const DIGRAPHS: Array<[string, string, string]> = [
  ['キャ', 'kya', '캬'],
  ['キュ', 'kyu', '큐'],
  ['キョ', 'kyo', '쿄'],
  ['ギャ', 'gya', '갸'],
  ['ギュ', 'gyu', '규'],
  ['ギョ', 'gyo', '교'],
  ['シャ', 'sha', '샤'],
  ['シュ', 'shu', '슈'],
  ['ショ', 'sho', '쇼'],
  ['シェ', 'she', '셰'],
  ['ジャ', 'ja', '자'],
  ['ジュ', 'ju', '주'],
  ['ジョ', 'jo', '조'],
  ['ジェ', 'je', '제'],
  ['チャ', 'cha', '차'],
  ['チュ', 'chu', '추'],
  ['チョ', 'cho', '초'],
  ['チェ', 'che', '체'],
  ['ヂャ', 'ja', '자'],
  ['ヂュ', 'ju', '주'],
  ['ヂョ', 'jo', '조'],
  ['ニャ', 'nya', '냐'],
  ['ニュ', 'nyu', '뉴'],
  ['ニョ', 'nyo', '뇨'],
  ['ヒャ', 'hya', '햐'],
  ['ヒュ', 'hyu', '휴'],
  ['ヒョ', 'hyo', '효'],
  ['ビャ', 'bya', '뱌'],
  ['ビュ', 'byu', '뷰'],
  ['ビョ', 'byo', '뵤'],
  ['ピャ', 'pya', '퍄'],
  ['ピュ', 'pyu', '퓨'],
  ['ピョ', 'pyo', '표'],
  ['ミャ', 'mya', '먀'],
  ['ミュ', 'myu', '뮤'],
  ['ミョ', 'myo', '묘'],
  ['リャ', 'rya', '랴'],
  ['リュ', 'ryu', '류'],
  ['リョ', 'ryo', '료'],
  ['ティ', 'ti', '티'],
  ['トゥ', 'tu', '투'],
  ['ディ', 'di', '디'],
  ['ドゥ', 'du', '두'],
  ['テュ', 'tyu', '튜'],
  ['デュ', 'dyu', '듀'],
  ['ファ', 'fa', '파'],
  ['フィ', 'fi', '피'],
  ['フェ', 'fe', '페'],
  ['フォ', 'fo', '포'],
  ['フュ', 'fyu', '퓨'],
  ['ウィ', 'wi', '위'],
  ['ウェ', 'we', '웨'],
  ['ウォ', 'wo', '워'],
  ['ヴァ', 'va', '바'],
  ['ヴィ', 'vi', '비'],
  ['ヴェ', 've', '베'],
  ['ヴォ', 'vo', '보'],
  ['ヴュ', 'vyu', '뷰'],
  ['ツァ', 'tsa', '차'],
  ['ツィ', 'tsi', '치'],
  ['ツェ', 'tse', '체'],
  ['ツォ', 'tso', '초'],
  ['イェ', 'ye', '예'],
  ['クァ', 'kwa', '콰'],
  ['クィ', 'kwi', '퀴'],
  ['クェ', 'kwe', '퀘'],
  ['クォ', 'kwo', '쿼'],
  ['グァ', 'gwa', '과'],
  ['スィ', 'si', '시'],
  ['ズィ', 'zi', '지'],
];

describe('kanaToRomaji / kanaToHangul — table coverage (mutant-resistant)', () => {
  for (const [kana, romaji, hangul] of MONOGRAPHS) {
    it(`monograph ${kana} -> ${romaji} / ${hangul}`, () => {
      expect(kanaToRomaji(kana)).toBe(romaji);
      expect(kanaToHangul(kana)).toBe(hangul);
    });
  }
  for (const [kana, romaji, hangul] of DIGRAPHS) {
    it(`digraph ${kana} -> ${romaji} / ${hangul}`, () => {
      expect(kanaToRomaji(kana)).toBe(romaji);
      expect(kanaToHangul(kana)).toBe(hangul);
    });
  }
});

describe('documented worked examples from the R4 brief', () => {
  it('マル -> maru / 마루', () => {
    expect(kanaToRomaji('マル')).toBe('maru');
    expect(kanaToHangul('マル')).toBe('마루');
  });
  it('ヨアソビ -> yoasobi / 요아소비', () => {
    expect(kanaToRomaji('ヨアソビ')).toBe('yoasobi');
    expect(kanaToHangul('ヨアソビ')).toBe('요아소비');
  });
  it('ハジマリハイツモアメ -> hajimarihaitsumoame / 하지마리하이쓰모아메', () => {
    expect(kanaToRomaji('ハジマリハイツモアメ')).toBe('hajimarihaitsumoame');
    expect(kanaToHangul('ハジマリハイツモアメ')).toBe('하지마리하이쓰모아메');
  });
  it('キャリー -> kyarii (chōon repeats the vowel) / 캬리 (chōon dropped)', () => {
    expect(kanaToRomaji('キャリー')).toBe('kyarii');
    expect(kanaToHangul('キャリー')).toBe('캬리');
  });
  it('ガッキュウ -> gakkyuu (sokuon doubles the next consonant)', () => {
    expect(kanaToRomaji('ガッキュウ')).toBe('gakkyuu');
    expect(kanaToHangul('ガッキュウ')).toBe('갓큐우');
  });
});

describe('sokuon (促音 ッ)', () => {
  it('doubles a following plain consonant (romaji) and adds ㅅ 받침 (hangul)', () => {
    expect(kanaToRomaji('サッカー')).toBe('sakkaa');
    expect(kanaToHangul('サッカー')).toBe('삿카');
  });
  it('renders ッ before a ch-mora as "t" (matchi, not macchi)', () => {
    expect(kanaToRomaji('マッチ')).toBe('matchi');
  });
  it('drops a word-final sokuon with nothing to double', () => {
    expect(kanaToRomaji('アッ')).toBe('a');
    expect(kanaToHangul('アッ')).toBe('앗');
  });
});

describe('moraic nasal (撥音 ン)', () => {
  it('is always "n" in romaji (no n’ disambiguation)', () => {
    expect(kanaToRomaji('シンイチ')).toBe('shinichi');
    expect(kanaToRomaji('ニッポン')).toBe('nippon');
  });
  it('attaches a ㄴ 받침 to the previous syllable in hangul', () => {
    expect(kanaToHangul('ニッポン')).toBe('닛폰');
    expect(kanaToHangul('ホン')).toBe('혼');
  });
  it('emits a standalone ㄴ jamo when it cannot attach', () => {
    expect(kanaToHangul('ン')).toBe('ㄴ');
  });
});

describe('chōon (長音 ー)', () => {
  it('repeats the preceding vowel as plain ASCII in romaji', () => {
    expect(kanaToRomaji('ラーメン')).toBe('raamen');
    expect(kanaToRomaji('メール')).toBe('meeru');
  });
  it('is dropped in hangul', () => {
    expect(kanaToHangul('ラーメン')).toBe('라멘');
  });
});

describe('iteration marks and middle dot', () => {
  it('ヽ repeats the previous mora; ヾ repeats it voiced', () => {
    expect(kanaToRomaji('ミヽ')).toBe('mimi');
    expect(kanaToRomaji('ハヾ')).toBe('haba');
  });
  it('・ becomes a separator', () => {
    expect(kanaToRomaji('ア・イ')).toBe('a i');
    expect(kanaToHangul('ア・イ')).toBe('아 이');
  });
});

describe('hiragana and width folding (NFKC + hiragana→katakana)', () => {
  it('accepts hiragana input identically to katakana', () => {
    expect(kanaToRomaji('まる')).toBe('maru');
    expect(kanaToHangul('まる')).toBe('마루');
  });
  it('folds half-width katakana via NFKC', () => {
    expect(kanaToRomaji('ﾏﾙ')).toBe('maru');
    expect(kanaToHangul('ﾏﾙ')).toBe('마루');
  });
});

describe('defensive handling of non-kana input', () => {
  it('never throws and passes ASCII alphanumerics through romaji, drops them in hangul', () => {
    expect(kanaToRomaji('AKB')).toBe('akb');
    expect(kanaToRomaji('マルABC')).toBe('maruabc');
    expect(kanaToHangul('マルABC')).toBe('마루');
  });
  it('returns empty for input with no readable kana', () => {
    expect(kanaToRomaji('丸')).toBe('');
    expect(kanaToHangul('丸')).toBe('');
    expect(kanaToRomaji('')).toBe('');
    expect(kanaToHangul('')).toBe('');
  });
});

describe('property invariants over random unicode', () => {
  const random = (): string => {
    let s = '';
    const length = Math.floor(Math.random() * 12);
    for (let i = 0; i < length; i += 1) {
      s += String.fromCodePoint(Math.floor(Math.random() * 0x2fff));
    }
    return s;
  };
  it('never throws and keeps output within its charset', () => {
    for (let i = 0; i < 2000; i += 1) {
      const input = random();
      const romaji = kanaToRomaji(input);
      const hangul = kanaToHangul(input);
      // Romaji output is plain lowercase ASCII alphanumerics and single spaces.
      expect(romaji).toMatch(/^[a-z0-9]*( [a-z0-9]+)*$/);
      // Hangul output is precomposed syllables, compatibility jamo, and spaces.
      expect(hangul).toMatch(/^[가-힣㄰-㆏]*( [가-힣㄰-㆏]+)*$/);
    }
  });
});
