import { hasKana, hasLatinLetter } from '@karaoke/search';
import { describe, expect, it } from 'vitest';
import {
  classifyJoysoundRecordWithReason,
  type JoysoundClassifyReason,
} from '../../../src/adapters/joysound-official/classifier.js';
import type { JoysoundDetail, JoysoundListItem } from '../../../src/adapters/joysound-official/types.js';

/**
 * Golden regression gate for the JOYSOUND classifier (T5-D).
 *
 * PURPOSE. This file freezes the classifier's `{ admit, reason }` verdict at
 * every gate and at every code point where the classifier's hand-rolled script
 * regexes diverge from the shared `@karaoke/search` predicates. It is the
 * change-specification harness for the safe-predicate unification:
 *
 *   - Part A snapshots the representative (listItem, detail) scenarios that
 *     exercise every branch of `classifyJoysoundRecordWithReason`.
 *   - Part B1 pins the CURRENT behaviour at the Phase-1 divergence code points
 *     (kana unification: `hasKanaScript`/`RE_KANA` → `hasKana`). When the swap
 *     lands, EXACTLY these assertions change; the git diff of Part B1 IS the
 *     behavioural change specification, and it must show only two effects:
 *     phonetic-extension kana now ADMITS (recall ↑) and half-width/phonetic
 *     kana echoes now SUPPRESS a foreign-Chinese determination (echo widening).
 *   - Part B2 pins the CURRENT behaviour at the Phase-2 divergence code points
 *     (Han / Hangul unification), which this scope deliberately does NOT touch.
 *     These assertions must stay GREEN through the Phase-1 swap — they prove the
 *     swap is scoped to kana only. They become the Phase-2 change spec later.
 *   - Part C is the always-on corpus differential: it asserts the shared kana
 *     predicate is a strict SUPERSET of the former regexes (so a genuine-JP kana
 *     match can never be LOST — dropout is structurally impossible) and that the
 *     only strings on which they differ are the documented widening zones.
 *
 * See docs/OPEN-QUESTIONS.md §"JOYSOUND classifier safe-predicate unification".
 */

function listItem(over: Partial<JoysoundListItem>): JoysoundListItem {
  return {
    naviGroupId: '900000',
    selSongNo: '900-000',
    songName: 'Song',
    artistName: 'Artist',
    artistId: null,
    tieupInfo: null,
    tieupId: null,
    ...over,
  };
}

function detail(over: Partial<JoysoundDetail>): JoysoundDetail {
  return {
    naviGroupId: '900000',
    songId: null,
    selSongNo: '900-000',
    songName: 'Song',
    songNameRuby: null,
    artistName: null,
    artistId: null,
    lyricist: null,
    composer: null,
    relDate: null,
    newFlg: null,
    lyricIntro: null,
    genreNames: [],
    tieupNames: [],
    aplServicePublishDates: [],
    ...over,
  };
}

type Verdict = { admit: boolean; reason: JoysoundClassifyReason };

// ---------------------------------------------------------------------------
// Part A — representative scenario snapshots (every gate).
// ---------------------------------------------------------------------------
describe('classifier golden — representative scenarios', () => {
  const cases: Array<{
    name: string;
    listItem: JoysoundListItem;
    detail?: JoysoundDetail;
    overrides?: { isAllow: (n: string) => boolean; isDrop: (n: string) => boolean };
    expected: Verdict;
  }> = [
    // positive gates
    {
      name: 'admit-vocaloid — 初音ミク artist',
      listItem: listItem({ songName: '千本桜', artistName: '初音ミク' }),
      expected: { admit: true, reason: 'admit-vocaloid' },
    },
    {
      name: 'admit-anime — TVアニメ tieup',
      listItem: listItem({ songName: '紅蓮華', artistName: 'LiSA', tieupInfo: 'TVアニメ「鬼滅の刃」OP' }),
      expected: { admit: true, reason: 'admit-anime' },
    },
    {
      name: 'admit-jpop-kana — pure-kana title',
      listItem: listItem({ songName: 'よるにかける', artistName: 'YOASOBI' }),
      expected: { admit: true, reason: 'admit-jpop-kana' },
    },
    // foreign-act gate (listing-only)
    {
      name: 'foreign-korean — Latin Korean-act pattern (aespa)',
      listItem: listItem({ songName: 'Set The Tone', artistName: 'aespa' }),
      expected: { admit: false, reason: 'foreign-korean' },
    },
    {
      name: 'foreign-korean — katakana Korean-act alias (チョンソミ) beats kana admit',
      listItem: listItem({ songName: 'x', artistName: 'チョンソミ' }),
      expected: { admit: false, reason: 'foreign-korean' },
    },
    {
      name: 'foreign-korean — production Korean drop list (박효신)',
      listItem: listItem({ songName: 'x', artistName: '박효신' }),
      expected: { admit: false, reason: 'foreign-korean' },
    },
    {
      name: 'foreign-chinese — production Chinese drop list (BEYOND)',
      listItem: listItem({ songName: 'x', artistName: 'BEYOND' }),
      expected: { admit: false, reason: 'foreign-chinese' },
    },
    {
      name: 'foreign-western — Western-act component (QUEEN)',
      listItem: listItem({ songName: 'WE WILL ROCK YOU', artistName: 'QUEEN' }),
      expected: { admit: false, reason: 'foreign-western' },
    },
    // override paths
    {
      name: 'reviewed-allow — curated ALLOW admits a Korean act before the foreign-act gate',
      listItem: listItem({ songName: 'Set The Tone', artistName: 'aespa', selSongNo: '222-222' }),
      overrides: { isDrop: () => false, isAllow: (n) => n === '222-222' },
      expected: { admit: true, reason: 'reviewed-allow' },
    },
    {
      name: 'reviewed-drop — curated DROP wins before any admit gate',
      listItem: listItem({ songName: '千本桜', artistName: '初音ミク', selSongNo: '111-111' }),
      overrides: { isDrop: (n) => n === '111-111', isAllow: () => false },
      expected: { admit: false, reason: 'reviewed-drop' },
    },
    // authoritative foreign-name detail gate (foreignNameSignal)
    {
      name: 'foreign-korean — detail Hangul foreign-name beats a kana listing title',
      listItem: listItem({ songName: 'サランヘヨ', artistName: 'アーティスト' }),
      detail: detail({ songNameForeign: '사랑해요' }),
      expected: { admit: false, reason: 'foreign-korean' },
    },
    {
      name: 'foreign-chinese — detail Han (no kana) foreign-name beats a kana listing title',
      listItem: listItem({ songName: 'カナ', artistName: 'アーティスト' }),
      detail: detail({ songNameForeign: '起风了' }),
      expected: { admit: false, reason: 'foreign-chinese' },
    },
    {
      name: 'foreign-chinese — detail CJK-compat ideograph (豈 U+F900) foreign-name',
      listItem: listItem({ songName: 'カナ', artistName: 'アーティスト' }),
      detail: detail({ songNameForeign: '豈' }),
      expected: { admit: false, reason: 'foreign-chinese' },
    },
    {
      name: 'foreign-chinese — dotted-pinyin corroborating search field',
      listItem: listItem({ songName: 'カナ', artistName: 'アーティスト' }),
      detail: detail({ artistNameForeignSearch: 'zhang.xue.you.' }),
      expected: { admit: false, reason: 'foreign-chinese' },
    },
    {
      name: 'admit-jpop-kana — full-width kana echo in foreign-name suppresses chinese',
      listItem: listItem({ songName: 'さくら', artistName: 'アーティスト' }),
      detail: detail({ songNameForeign: '桜サクラ' }),
      expected: { admit: true, reason: 'admit-jpop-kana' },
    },
    // detail-gated JP recovery + 洋楽 veto
    {
      name: 'admit-jp-detail — Han-only title, empty foreign-name, no 洋楽',
      listItem: listItem({ songName: '漢字', artistName: '漢字' }),
      detail: detail({ songName: '漢字' }),
      expected: { admit: true, reason: 'admit-jp-detail' },
    },
    {
      name: 'admit-jp-detail — Latin-only title, empty foreign-name, no 洋楽',
      listItem: listItem({ songName: 'Namae', artistName: 'Artist' }),
      detail: detail({ songName: 'Namae' }),
      expected: { admit: true, reason: 'admit-jp-detail' },
    },
    {
      name: 'drop-ascii-only — 洋楽 genre tag vetoes the JP recovery',
      listItem: listItem({ songName: 'Namae', artistName: 'Artist' }),
      detail: detail({ songName: 'Namae', genreNames: ['洋楽'] }),
      expected: { admit: false, reason: 'drop-ascii-only' },
    },
    // fall-through drops (listing-only)
    {
      name: 'drop-han-only — Han but no kana',
      listItem: listItem({ songName: '起风了', artistName: '买辣椒也用券' }),
      expected: { admit: false, reason: 'drop-han-only' },
    },
    {
      name: 'drop-ascii-only — Latin only',
      listItem: listItem({ songName: 'Generic Latin', artistName: 'LatinArtist' }),
      expected: { admit: false, reason: 'drop-ascii-only' },
    },
    {
      name: 'drop-no-signal — neither Han, Latin nor kana',
      listItem: listItem({ songName: '?!', artistName: '???' }),
      expected: { admit: false, reason: 'drop-no-signal' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        classifyJoysoundRecordWithReason({
          listItem: c.listItem,
          detail: c.detail,
          overrides: c.overrides,
        }),
      ).toEqual(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Part B1 — Phase-1 divergence code points (kana unification).
//
// These assertions encode the CURRENT (pre-swap) verdict. When
// `hasKanaScript`/`RE_KANA` are replaced by the shared `hasKana`, EXACTLY these
// four assertions flip; their diff is the Phase-1 change specification.
// ---------------------------------------------------------------------------
describe('classifier golden — Phase-1 divergence code points (kana)', () => {
  // Bare title/artist made only of the probe code point (isolates the
  // admit-path kana test in positiveSignalKind).
  const bare = (cp: string) => listItem({ songName: cp, artistName: cp });
  // Genuine-JP kana listing whose detail foreign-name is a Han+kana echo
  // (isolates the echo-path kana test in foreignNameSignal).
  const echo = (foreign: string) => ({
    listItem: listItem({ songName: 'さくら', artistName: 'アーティスト' }),
    detail: detail({ songNameForeign: foreign }),
  });

  it('phonetic-extension kana ㇰ (U+31F0) in title — CURRENT drop-no-signal (Phase-1 will admit)', () => {
    expect(classifyJoysoundRecordWithReason({ listItem: bare('ㇰ') })).toEqual({
      admit: false,
      reason: 'drop-no-signal',
    });
  });

  it('phonetic-extension kana ㇿ (U+31FF) in title — CURRENT drop-no-signal (Phase-1 will admit)', () => {
    expect(classifyJoysoundRecordWithReason({ listItem: bare('ㇿ') })).toEqual({
      admit: false,
      reason: 'drop-no-signal',
    });
  });

  it('half-width kana echo ｱｲｳ (U+FF71+) in foreign-name — CURRENT foreign-chinese (Phase-1 will suppress → admit)', () => {
    expect(classifyJoysoundRecordWithReason(echo('桜ｱｲｳ'))).toEqual({
      admit: false,
      reason: 'foreign-chinese',
    });
  });

  it('phonetic-extension kana echo ㇰ (U+31F0) in foreign-name — CURRENT foreign-chinese (Phase-1 will suppress → admit)', () => {
    expect(classifyJoysoundRecordWithReason(echo('桜ㇰ'))).toEqual({
      admit: false,
      reason: 'foreign-chinese',
    });
  });
});

// ---------------------------------------------------------------------------
// Part B2 — Phase-2 divergence code points (Han / Hangul), OUT OF SCOPE here.
//
// The classifier still uses its own `RE_HAN` / `RE_HANGUL` / `RE_HAN_FOREIGN`
// regexes for the drop-reason split and the foreign-name Korean/Chinese signal.
// These assertions pin the CURRENT behaviour and MUST stay green through the
// Phase-1 swap — proving Phase-1 is kana-only. They are the Phase-2 change spec:
// once those regexes move to the shared `hasHan`/`hasHangul`, these flip.
// ---------------------------------------------------------------------------
describe('classifier golden — Phase-2 divergence code points (Han/Hangul, unchanged in Phase-1)', () => {
  const bare = (cp: string) => listItem({ songName: cp, artistName: cp });
  const kanaListingForeign = (foreign: string) => ({
    listItem: listItem({ songName: 'カナ', artistName: 'アーティスト' }),
    detail: detail({ songNameForeign: foreign }),
  });

  it('supplementary-plane Han 𠮟 (U+20B9F) bare title — drop-no-signal (RE_HAN misses; hasHan would drop-han-only)', () => {
    expect(classifyJoysoundRecordWithReason({ listItem: bare('\u{20B9F}') })).toEqual({
      admit: false,
      reason: 'drop-no-signal',
    });
  });

  it('CJK-compat ideograph 豈 (U+F900) bare title — drop-no-signal (RE_HAN misses in drop-reason path)', () => {
    expect(classifyJoysoundRecordWithReason({ listItem: bare('豈') })).toEqual({
      admit: false,
      reason: 'drop-no-signal',
    });
  });

  it('ideographic-zero 〇 (U+3007) bare title — drop-no-signal (below RE_HAN floor)', () => {
    expect(classifyJoysoundRecordWithReason({ listItem: bare('〇') })).toEqual({
      admit: false,
      reason: 'drop-no-signal',
    });
  });

  it('Yijing hexagram ䷀ (U+4DC0) bare title — drop-han-only (in RE_HAN range but NOT \\p{Han}; hasHan would drop-no-signal)', () => {
    expect(classifyJoysoundRecordWithReason({ listItem: bare('䷀') })).toEqual({
      admit: false,
      reason: 'drop-han-only',
    });
  });

  it('supplementary-plane Han 𠮟 (U+20B9F) foreign-name — kana title still admits (RE_HAN_FOREIGN misses; hasHan would foreign-chinese)', () => {
    expect(classifyJoysoundRecordWithReason(kanaListingForeign('\u{20B9F}'))).toEqual({
      admit: true,
      reason: 'admit-jpop-kana',
    });
  });

  it('half-width Hangul ﾡ (U+FFA1) foreign-name — kana title still admits (RE_HANGUL misses; hasHangul would foreign-korean)', () => {
    expect(classifyJoysoundRecordWithReason(kanaListingForeign('ﾡ'))).toEqual({
      admit: true,
      reason: 'admit-jpop-kana',
    });
  });

  it('Hangul-jamo-ext-A ꥠ (U+A960) foreign-name — kana title still admits (RE_HANGUL misses; hasHangul would foreign-korean)', () => {
    expect(classifyJoysoundRecordWithReason(kanaListingForeign('ꥠ'))).toEqual({
      admit: true,
      reason: 'admit-jpop-kana',
    });
  });
});

// ---------------------------------------------------------------------------
// Part C — always-on corpus differential (representative sample + divergence
// code points). Proves the kana swap is a strict widening: the shared `hasKana`
// never LOSES a match the former regexes had (so genuine-JP dropout is
// structurally impossible), and the only strings where they differ carry a
// phonetic-extension kana (admit path) or a phonetic-extension / half-width
// kana (echo path). Also confirms the Latin swap is byte-identical.
//
// The former regexes are inlined as frozen constants so this test remains a
// standalone contract after the production regexes are deleted.
// ---------------------------------------------------------------------------
describe('classifier differential — kana widening & Latin identity', () => {
  // Former `hasKanaScript` union (RE_HIRAGANA | RE_KATAKANA): hiragana,
  // full-width katakana, and half-width katakana. Used by the admit path.
  const FORMER_KANA_ADMIT = /[぀-ゟ゠-ヿｦ-ﾟ]/u;
  // Former `RE_KANA` (echo path): hiragana + full-width katakana blocks only —
  // no phonetic extensions, no half-width forms.
  const FORMER_KANA_ECHO = /[぀-ヿ]/u;
  // Former `RE_ASCII_LETTER`.
  const FORMER_LATIN = /[A-Za-z]/;

  // A representative multi-script corpus sample plus every documented
  // divergence code point.
  const probes: string[] = [
    // real-corpus-shaped samples
    'よるにかける',
    'サクラ',
    'ｻｸﾗ',
    '漢字仮名',
    '起风了',
    '사랑해요',
    'Generic Latin',
    'YOASOBI',
    'aespa',
    '初音ミク',
    'TVアニメ「鬼滅の刃」',
    '桜サクラ',
    '?!',
    '',
    // Phase-1 kana divergence code points
    'ㇰ', // U+31F0 phonetic-ext
    'ㇿ', // U+31FF phonetic-ext
    'ｱ', // U+FF71 half-width kana
    '桜ｱｲｳ',
    '桜ㇰ',
    // Phase-2 divergence code points (must not affect kana predicates)
    '\u{20B9F}',
    '豈',
    '〇',
    '䷀',
    'ﾡ',
    'ꥠ',
  ];

  const inAdmitWideningZone = (s: string) => [...s].some((ch) => {
    const c = ch.codePointAt(0)!;
    return c >= 0x31f0 && c <= 0x31ff; // phonetic-extension kana only
  });
  const inEchoWideningZone = (s: string) => [...s].some((ch) => {
    const c = ch.codePointAt(0)!;
    return (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f); // phonetic-ext + half-width
  });

  it('shared hasKana is a strict SUPERSET of the former admit-path regex (no match ever lost)', () => {
    for (const s of probes) {
      if (FORMER_KANA_ADMIT.test(s)) {
        expect(hasKana(s), `former-admit-kana match must survive: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });

  it('shared hasKana is a strict SUPERSET of the former echo-path regex (no match ever lost)', () => {
    for (const s of probes) {
      if (FORMER_KANA_ECHO.test(s)) {
        expect(hasKana(s), `former-echo-kana match must survive: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });

  it('admit-path widening is confined to phonetic-extension kana', () => {
    for (const s of probes) {
      if (hasKana(s) !== FORMER_KANA_ADMIT.test(s)) {
        expect(inAdmitWideningZone(s), `unexpected admit-path flip: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });

  it('echo-path widening is confined to phonetic-extension + half-width kana', () => {
    for (const s of probes) {
      if (hasKana(s) !== FORMER_KANA_ECHO.test(s)) {
        expect(inEchoWideningZone(s), `unexpected echo-path flip: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });

  it('Latin swap is byte-identical (hasLatinLetter === former RE_ASCII_LETTER)', () => {
    for (const s of probes) {
      expect(hasLatinLetter(s), `latin mismatch: ${JSON.stringify(s)}`).toBe(FORMER_LATIN.test(s));
    }
  });
});
