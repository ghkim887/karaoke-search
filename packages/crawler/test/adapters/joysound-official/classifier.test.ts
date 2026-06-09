import { describe, expect, it } from 'vitest';
import { classifyJoysoundRecord } from '../../../src/adapters/joysound-official/classifier.js';
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

describe('classifyJoysoundRecord — admit via vocaloid signal', () => {
  it('marks 初音ミク records as vocaloid via artist name', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ artistName: '初音ミク', songName: '千本桜' }),
      }),
    ).toBe(true);
  });

  it('marks records as vocaloid when the artist is feat. a known voicebank', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ artistName: '黒うさP feat. 初音ミク', songName: '千本桜' }),
      }),
    ).toBe(true);
  });

  it('catches additional voicebank tokens (鏡音リン / GUMI / 重音テト / 可不)', () => {
    for (const name of [
      '鏡音リン',
      '鏡音レン',
      '巡音ルカ',
      'GUMI',
      'MEIKO',
      'KAITO',
      '重音テト',
      '可不',
    ]) {
      expect(
        classifyJoysoundRecord({ listItem: listItem({ artistName: name }) }),
        `failed for ${name}`,
      ).toBe(true);
    }
  });

  it('catches VOCALOID via detail.genreNames (case-insensitive)', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({}),
        detail: detail({ genreNames: ['Vocaloid'] }),
      }),
    ).toBe(true);
  });

  it('catches ボカロ in songName', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'ボカロメドレー', artistName: '某P' }),
      }),
    ).toBe(true);
  });

  it('catches プロジェクトセカイ in tieupInfo', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: 'X',
          artistName: 'Y',
          tieupInfo: 'プロジェクトセカイ',
        }),
      }),
    ).toBe(true);
  });

  it('catches v flower only with artist-field vocaloid context', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'UnderStand', artistName: 'BCNO feat.flower' }),
      }),
    ).toBe(true);

    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Original Song', artistName: 'v flower' }),
      }),
    ).toBe(true);
  });
});

describe('classifyJoysoundRecord — admit via anime signal', () => {
  it('marks アニメ tieupInfo as anime', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: '紅蓮華',
          artistName: 'LiSA',
          tieupInfo: 'TVアニメ「鬼滅の刃」OP',
        }),
      }),
    ).toBe(true);
  });

  it('marks 主題歌 / 挿入歌 with anime context as anime (via アニメ token)', () => {
    for (const tieup of ['アニメ主題歌', 'アニメED主題歌', 'TVアニメ「X」挿入歌']) {
      expect(
        classifyJoysoundRecord({
          listItem: listItem({ tieupInfo: tieup }),
        }),
        `failed for ${tieup}`,
      ).toBe(true);
    }
  });

  it('marks 特撮 tieupInfo as anime', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ tieupInfo: '特撮「仮面ライダー」OP' }),
      }),
    ).toBe(true);
  });

  it('marks 劇場版 tieupInfo as anime', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ tieupInfo: '劇場版アニメOP' }),
      }),
    ).toBe(true);
  });

  it('does NOT classify on 映画 or 主題歌 / 挿入歌 without anime context', () => {
    // 映画 alone — live-action film tieup, no anime signal
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: 'Latin Title',
          artistName: 'LatinArtist',
          tieupInfo: '映画「X」',
        }),
      }),
    ).toBe(false);

    // 映画 + 主題歌 — still no anime/特撮/character context → drop
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: 'Latin Title',
          artistName: 'LatinArtist',
          tieupInfo: '映画「X」主題歌',
        }),
      }),
    ).toBe(false);

    // bare 挿入歌 with no anime context → drop
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: 'Latin Title',
          artistName: 'LatinArtist',
          tieupInfo: '挿入歌',
        }),
      }),
    ).toBe(false);
  });

  it('does NOT classify Latin text containing OP/ED letter sequences as anime', () => {
    for (const [songName, artistName] of [
      ["HYMNE A L'AMOUR", 'EDITH PIAF'],
      ['KEEP PASSING THE OPEN WINDOWS', 'QUEEN'],
      ['Ambition', 'ZIPANG OPERA'],
    ] as const) {
      expect(
        classifyJoysoundRecord({
          listItem: listItem({ songName, artistName }),
        }),
        `failed for ${songName} / ${artistName}`,
      ).toBe(false);
    }
  });

  it('does NOT classify transliterated songNameRuby alone as anime', () => {
    for (const [songName, artistName, songNameRuby] of [
      ['animation', 'AliA', 'アニメーション'],
      ['ANIME', 'LUCKY TAPES', 'アニメ'],
    ] as const) {
      expect(
        classifyJoysoundRecord({
          listItem: listItem({ songName, artistName }),
          detail: detail({ songName, songNameRuby, artistName }),
        }),
        `failed for ${songName} / ${artistName}`,
      ).toBe(false);
    }
  });

  it('still classifies detail tie-up anime evidence as anime', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Latin Title', artistName: 'LatinArtist' }),
        detail: detail({
          songName: 'Latin Title',
          songNameRuby: 'ラテンタイトル',
          artistName: 'LatinArtist',
          tieupNames: ['TVアニメ「X」OP'],
        }),
      }),
    ).toBe(true);
  });

  it('catches CV: / キャラクター tieup signals', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ tieupInfo: 'キャラクターソング' }),
      }),
    ).toBe(true);
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ artistName: '主人公(CV:山田太郎)' }),
      }),
    ).toBe(true);
  });

  it('admits when both vocaloid and anime signals fire', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: 'X',
          artistName: '初音ミク',
          tieupInfo: 'TVアニメ「Y」OP',
        }),
      }),
    ).toBe(true);
  });
});

describe('classifyJoysoundRecord — admit via kana signal', () => {
  it('marks pure-kana title songs as jpop', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'よるにかける', artistName: 'YOASOBI' }),
      }),
    ).toBe(true);
  });

  it('does not drop Japanese rows just because the title contains a Korean-act token', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'SEVENTEEN', artistName: 'あいみょん' }),
      }),
    ).toBe(true);
  });

  it('does not use detail ruby alone as J-pop evidence', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Lemon', artistName: '米津玄師' }),
        detail: detail({ songName: 'Lemon', songNameRuby: 'レモン', artistName: '米津玄師' }),
      }),
    ).toBe(false);
  });

  it('drops pure-Latin foreign rows even when JOYSOUND supplies kana ruby', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: "Style (Taylor's Version)", artistName: 'TAYLOR SWIFT' }),
        detail: detail({
          songName: "Style (Taylor's Version)",
          songNameRuby: 'スタイルテイラーズバージョン',
          artistName: 'TAYLOR SWIFT',
        }),
      }),
    ).toBe(false);
  });
});

describe('classifyJoysoundRecord — drop', () => {
  it('drops K-pop rows like Set The Tone / aespa', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Set The Tone', artistName: 'aespa' }),
      }),
    ).toBe(false);
  });

  it('drops Chaconne / ENHYPEN', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Chaconne', artistName: 'ENHYPEN' }),
      }),
    ).toBe(false);
  });

  it('drops pure-Latin K-pop rows even when JOYSOUND supplies kana ruby', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Heavenly', artistName: 'NCT DREAM' }),
        detail: detail({
          songName: 'Heavenly',
          songNameRuby: 'ヘブンリー',
          artistName: 'NCT DREAM',
        }),
      }),
    ).toBe(false);
  });

  it('drops observed JOYSOUND katakana Korean-act aliases', () => {
    for (const artistName of ['チョンソミ', 'セブンティーン']) {
      expect(
        classifyJoysoundRecord({
          listItem: listItem({ songName: 'Gold Gold Gold', artistName }),
          detail: detail({
            songName: 'Gold Gold Gold',
            songNameRuby: 'ゴールドゴールドゴールド',
            artistName,
          }),
        }),
        `failed for ${artistName}`,
      ).toBe(false);
    }
  });

  it('drops full-catalog Korean-act leaks from artist fields', () => {
    for (const [artistName, songName] of [
      ['BTS', 'IDOL -Japanese ver.-'],
      ['BLACKPINK', "AS IF IT'S YOUR LAST"],
      ['TWICE', 'BDZ'],
      ['東方神起', '明日は来るから'],
      ['TOMORROW X TOGETHER', '紫陽花のような恋 (Hydrangea Love)'],
      ['TREASURE (トレジャー)', 'ありがとう (ASAHI x HARUTO Unit)'],
      ['BIGBANG', 'MY HEAVEN'],
      ['レッドベルベット', 'Ice Cream Cake'],
      ['モンスタエックス', 'Love Killa'],
      ['ママムー', 'HIP'],
      ['GFRIEND(ヨジャチング)', '今日から私たちは'],
      ['Super Junior', 'Sorry，Sorry'],
    ] as const) {
      expect(
        classifyJoysoundRecord({
          listItem: listItem({ songName, artistName }),
          detail: detail({ songName, artistName }),
        }),
        `failed for ${artistName}`,
      ).toBe(false);
    }
  });

  it('drops high-confidence full-catalog Western-act leaks from artist fields', () => {
    for (const [artistName, songName] of [
      ['QUEEN', 'WE WILL ROCK YOU《LIVEカラオケ》'],
      ['レディー・ガガ、ホアキン・フェニックス', '(They Long To Be) Close To You'],
      ['伊藤由奈×セリーヌ・ディオン', 'あなたがいる限り ～A WORLD TO BELIEVE IN～'],
      [
        'ブラッツ featuring BoA・アンド・ハウイー・ディー(バックストリート・ボーイズ)',
        'ショウ・ミー・ホワット・ユー・ガット',
      ],
    ] as const) {
      expect(
        classifyJoysoundRecord({ listItem: listItem({ songName, artistName }) }),
        `failed for ${artistName}`,
      ).toBe(false);
    }
  });

  it('drops Western acts even when list and detail artist fields are duplicated', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({
          songName: 'WE WILL ROCK YOU《LIVEカラオケ》',
          artistName: 'QUEEN',
        }),
        detail: detail({
          songName: 'WE WILL ROCK YOU《LIVEカラオケ》',
          songNameRuby: 'ウィーウィルロックユーライブカラオケ',
          artistName: 'QUEEN',
        }),
      }),
    ).toBe(false);
  });

  it('does not drop Japanese artists whose names merely contain Western-act substrings', () => {
    for (const [artistName, songName] of [
      ['CLAN QUEEN', '禁断の森《レコおと》'],
      ['Queen & Elizabeth', 'Love・Wars'],
      ['メジロマックイーン (CV.大西沙織)', '木漏れ日のエール'],
      ['クイーンミラージュ(CV:國府田マリ子)', 'イミテーションWORLD'],
    ] as const) {
      expect(
        classifyJoysoundRecord({ listItem: listItem({ songName, artistName }) }),
        `failed for ${artistName}`,
      ).toBe(true);
    }
  });

  it('does not drop Japanese artists whose names merely contain Korean-act substrings', () => {
    for (const artistName of [
      'アルカラ',
      'カラフルピーチ',
      'シャイニーカラーズ',
      '鉄道カラオケ(fromテイチク鉄道ビデオ)',
    ]) {
      expect(
        classifyJoysoundRecord({
          listItem: listItem({ songName: 'ありがとう', artistName }),
        }),
        `failed for ${artistName}`,
      ).toBe(true);
    }
  });

  it('drops pure-Latin rows with no Japanese / vocaloid / anime signal', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Generic Latin', artistName: 'LatinArtist' }),
      }),
    ).toBe(false);
  });

  it('does not promote ordinary Latin flower/GUMI substrings as vocaloid', () => {
    for (const [songName, artistName] of [
      ['Upper flower', 'PIERROT'],
      ["You Don't Bring Me Flowers", 'BARBRA STREISAND DUET WITH NEIL DIAMOND'],
      ['Imagination', 'Flower'],
      ['No Limit', 'MEGUMI'],
      ['Love Majic feat.LUNA，TSUGUMI from SOULHEAD & JAMOSA', 'lecca'],
    ] as const) {
      expect(
        classifyJoysoundRecord({ listItem: listItem({ songName, artistName }) }),
        `failed for ${songName} / ${artistName}`,
      ).toBe(false);
    }
  });

  it('drops CJK-only rows without kana/ruby or explicit anime/vocaloid evidence', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: '起风了', artistName: '买辣椒也用券' }),
        detail: detail({
          songName: '起风了',
          songNameRuby: null,
          artistName: '买辣椒也用券',
        }),
      }),
    ).toBe(false);
  });

  it('does not promote Latin-title rows from staff-only Japanese-script evidence', () => {
    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: 'Generic Latin', artistName: 'LatinArtist' }),
        detail: detail({
          songName: 'Generic Latin',
          songNameRuby: null,
          artistName: 'LatinArtist',
          lyricist: '山田太郎',
          composer: 'さとう花子',
        }),
      }),
    ).toBe(false);
  });
});
