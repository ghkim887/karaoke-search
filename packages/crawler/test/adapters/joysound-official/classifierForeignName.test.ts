import { describe, expect, it } from 'vitest';
import { classifyJoysoundRecordWithReason } from '../../../src/adapters/joysound-official/classifier.js';
import type {
  JoysoundDetail,
  JoysoundListItem,
} from '../../../src/adapters/joysound-official/types.js';

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
    artistName: 'Artist',
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

// --- Script samples built from code points (keeps literal CJK minimal). ---
// Hangul syllable (U+AC00 block): U+D55C = "han". A real Korean foreign-name.
const HANGUL_SAMPLE = String.fromCodePoint(0xd55c, 0xae00); // "한글" (hangeul)
// Han ideograph with NO kana (U+4E00 block): U+8D77 + U+98CE = a Mandopop title.
const HAN_NO_KANA_SAMPLE = String.fromCodePoint(0x8d77, 0x98ce); // "起风" (qi feng)
// Pure-katakana foreign-name echo (U+30A2 block): NOT a foreign signal.
const KANA_SAMPLE = String.fromCodePoint(0x30a2, 0x30a4); // "アイ" (ai)
// Kanji-only JP title (Han, no kana) — would hit drop-han-only WITHOUT detail.
const KANJI_TITLE = String.fromCodePoint(0x604b); // "恋" (koi)

describe('classifyJoysoundRecordWithReason — authoritative foreign-name detail gate', () => {
  it('drops foreign-korean when artistNameForeign carries Hangul (even with a katakana title)', () => {
    // The reverted katakana case: a pure-katakana title that previously fired
    // the crude translit gate. Now the AUTHORITATIVE signal is the populated
    // Korean foreign-name field on the detail.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({ artistNameForeign: HANGUL_SAMPLE }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-korean' });
  });

  it('drops foreign-chinese when songNameForeign carries Han and no kana', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({ songNameForeign: HAN_NO_KANA_SAMPLE }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-chinese' });
  });

  it('does NOT treat a kana-only foreign-name as a foreign signal — admits jpop-kana', () => {
    // A kana-bearing foreign-name is a JP-title echo, not a foreign signal, so
    // foreignNameSignal === null and the normal kana admit path wins.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({ songNameForeign: KANA_SAMPLE, artistNameForeign: KANA_SAMPLE }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });

  it('recovers a kanji-only JP title (would be drop-han-only) via admit-jp-detail when foreign-name empty', () => {
    // No kana anywhere → not jpop; Han present → would terminally drop-han-only.
    // Empty foreign-name is AUTHORITATIVE proof of a genuine JP song → admit.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANJI_TITLE, artistName: KANJI_TITLE }),
        detail: detail({ songName: KANJI_TITLE, artistName: KANJI_TITLE }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jp-detail' });
  });

  it('recovers a Latin-only JP act (would be drop-ascii-only) via admit-jp-detail when foreign-name empty', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Lemon', artistName: 'SomeJpAct' }),
        detail: detail({ songName: 'Lemon', artistName: 'SomeJpAct' }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jp-detail' });
  });

  it('keeps reviewed-allow precedence: an ALLOW number with a Korean foreign-name still admits via reviewed-allow', () => {
    // K-pop Japanese releases on the ALLOW list DO carry populated foreign-name
    // fields. The gate runs AFTER reviewed-allow, so the curated verdict wins.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({
          songName: KANA_SAMPLE,
          artistName: KANA_SAMPLE,
          selSongNo: '222-222',
        }),
        detail: detail({ artistNameForeign: HANGUL_SAMPLE }),
        overrides: {
          isDrop: () => false,
          isAllow: (n) => n === '222-222',
        },
      }),
    ).toEqual({ admit: true, reason: 'reviewed-allow' });
  });

  it('keeps reviewed-drop precedence: a DROP number with empty foreign-name still drops via reviewed-drop', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({
          songName: KANJI_TITLE,
          artistName: KANJI_TITLE,
          selSongNo: '111-111',
        }),
        detail: detail({ songName: KANJI_TITLE, artistName: KANJI_TITLE }),
        overrides: {
          isDrop: (n) => n === '111-111',
          isAllow: () => false,
        },
      }),
    ).toEqual({ admit: false, reason: 'reviewed-drop' });
  });

  it('the foreign-name DROP gate precedes the positive cascade (Korean foreign-name beats a kana title)', () => {
    // Even though the kana title would admit-jpop-kana, the populated Korean
    // foreign-name on the detail drops it first.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: 'Latin Artist' }),
        detail: detail({ artistNameForeign: HANGUL_SAMPLE }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-korean' });
  });
});

describe('classifyJoysoundRecordWithReason — C1 dotted-pinyin *ForeignSearch corroborating chinese tell', () => {
  it('drops foreign-chinese when songNameForeign is Han-no-kana AND songNameForeignSearch is dotted-pinyin (unchanged Han rule still fires)', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({
          songNameForeign: HAN_NO_KANA_SAMPLE,
          songNameForeignSearch: 'qi.feng.',
        }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-chinese' });
  });

  it('drops foreign-chinese via dotted-pinyin when the foreign-name field is EMPTY but *ForeignSearch is dotted-pinyin (NEW)', () => {
    // Neither Hangul nor Han-no-kana fired (foreign-name fields empty), but the
    // romanization search field is dotted pinyin → corroborating chinese tell.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({ artistNameForeignSearch: 'wu.lai.' }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-chinese' });
  });

  it('does NOT override a Hangul→korean determination when romanization is also present', () => {
    // Korean foreign-name + some romanization: Hangul wins, stays korean.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({
          artistNameForeign: HANGUL_SAMPLE,
          artistNameForeignSearch: 'jang.yun.jeong.',
        }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-korean' });
  });

  it('does NOT fire on a genuine-JP row (all foreign fields empty incl. *ForeignSearch) — admits jpop-kana', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({}),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });

  it('does NOT fire on non-dotted romanization (plain latin words are not the chinese tell)', () => {
    // A kana title with a plain (non-dotted) romanization search field stays JP.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({ songNameForeignSearch: 'yorunikakeru' }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });
});

describe('classifyJoysoundRecordWithReason — C2 artistNameForeign feeds the drop-list scan', () => {
  // `J-Walk` is a Korean drop-list entry (Latin form, no Hangul variant). As an
  // `artistNameForeign` it does NOT trip foreignNameSignal (no Hangul/Han), so
  // ONLY the widened drop-list scan can catch it.
  const DROPLIST_NATIVE = 'J-Walk';

  it('drops foreign-korean when artistNameForeign is on the Korean drop-list but the katakana artistName is not (NEW)', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({ artistName: KANA_SAMPLE, artistNameForeign: DROPLIST_NATIVE }),
      }),
    ).toEqual({ admit: false, reason: 'foreign-korean' });
  });

  it('listing-only (no detail) does NOT see the native name → admits jpop-kana (drop-list scan inert without detail)', () => {
    // Without a detail there is no artistNameForeign, so the katakana row admits.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });
});

describe('classifyJoysoundRecordWithReason — 洋楽 genre veto on the admit-jp-detail recovery', () => {
  // Layer-3 400-row precision audit (2026-06-12): JOYSOUND only populates the
  // foreign-name fields for Korean/Chinese entries, so a natively-Latin
  // Western/OPM/Bollywood row ALSO has `foreignNameSignal === null` — null is
  // not proof of genuine-JP there. The catalog's own `洋楽` genre tag is the
  // authoritative veto for those rows.
  const YOUGAKU = String.fromCodePoint(0x6d0b, 0x697d); // "洋楽"

  it('vetoes the recovery for a Latin-only row tagged 洋楽 → drop-ascii-only', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'MY HEART WILL GO ON', artistName: 'Some Western Act' }),
        detail: detail({
          songName: 'MY HEART WILL GO ON',
          artistName: 'Some Western Act',
          genreNames: [YOUGAKU],
        }),
      }),
    ).toEqual({ admit: false, reason: 'drop-ascii-only' });
  });

  it('vetoes the recovery for a Han-only row tagged 洋楽 → drop-han-only', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANJI_TITLE, artistName: KANJI_TITLE }),
        detail: detail({
          songName: KANJI_TITLE,
          artistName: KANJI_TITLE,
          genreNames: [YOUGAKU],
        }),
      }),
    ).toEqual({ admit: false, reason: 'drop-han-only' });
  });

  it('still vetoes when 洋楽 appears alongside other genres', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Latin Title', artistName: 'Latin Act' }),
        detail: detail({
          songName: 'Latin Title',
          artistName: 'Latin Act',
          genreNames: ['POPS', YOUGAKU],
        }),
      }),
    ).toEqual({ admit: false, reason: 'drop-ascii-only' });
  });

  it('does NOT veto a non-洋楽 genre — the recovery still admits via admit-jp-detail', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Lemon', artistName: 'SomeJpAct' }),
        detail: detail({ songName: 'Lemon', artistName: 'SomeJpAct', genreNames: ['POPS'] }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jp-detail' });
  });

  it('is SCOPED to the recovery: a kana title tagged 洋楽 still admits via admit-jpop-kana', () => {
    // A genuine JP act's English cover can carry 洋楽; the kana gate fires
    // BEFORE step 6, so the veto never sees it.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
        detail: detail({
          songName: KANA_SAMPLE,
          artistName: KANA_SAMPLE,
          genreNames: [YOUGAKU],
        }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });

  it('is SCOPED to the recovery: a known-JP-artist row tagged 洋楽 still admits via admit-jp-artist', () => {
    // The injected known-Japanese-artist seam (step 5) runs BEFORE step 6 — a
    // corpus-confirmed JP act's Latin-titled 洋楽 cover stays admitted.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'English Cover', artistName: 'KnownJpAct' }),
        detail: detail({
          songName: 'English Cover',
          artistName: 'KnownJpAct',
          genreNames: [YOUGAKU],
        }),
        isKnownJapaneseArtist: (artist) => artist === 'KnownJpAct',
      }),
    ).toEqual({ admit: true, reason: 'admit-jp-artist' });
  });
});

describe('classifyJoysoundRecordWithReason — detail-gated foreign-name signal is inert without detail', () => {
  it('listing-only kanji title still drops drop-han-only (no admit-jp-detail recovery without detail)', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANJI_TITLE, artistName: KANJI_TITLE }),
      }),
    ).toEqual({ admit: false, reason: 'drop-han-only' });
  });

  it('listing-only Latin title still drops drop-ascii-only (no admit-jp-detail recovery without detail)', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Lemon', artistName: 'SomeJpAct' }),
      }),
    ).toEqual({ admit: false, reason: 'drop-ascii-only' });
  });

  it('listing-only kana title admits jpop-kana unchanged (foreign-name gate inert)', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: KANA_SAMPLE, artistName: KANA_SAMPLE }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });
});
