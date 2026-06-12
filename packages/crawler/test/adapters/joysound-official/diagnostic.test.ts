import { describe, expect, it } from 'vitest';
import { buildJoysoundDecision } from '../../../src/adapters/joysound-official/diagnostic.js';
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
    selSongNo: '900000',
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

describe('buildJoysoundDecision', () => {
  it('admits a kana-titled jpop row with detailFlipRisk (listing-only might really be vocaloid/anime)', () => {
    expect(
      buildJoysoundDecision(
        listItem({
          naviGroupId: '100',
          selSongNo: '100-200',
          songName: 'よるにかける',
          artistName: 'YOASOBI',
        }),
      ),
    ).toEqual({
      selSongNo: '100200',
      selSongNoRaw: '100-200',
      naviGroupId: '100',
      title: 'よるにかける',
      artist: 'YOASOBI',
      tieupInfo: null,
      decision: 'admit',
      reason: 'admit-jpop-kana',
      detailFlipRisk: true,
    });
  });

  it('drops a Korean act (foreign-korean) with no detailFlipRisk', () => {
    expect(
      buildJoysoundDecision(
        listItem({
          naviGroupId: '101',
          selSongNo: '101-300',
          songName: 'Set The Tone',
          artistName: 'aespa',
        }),
      ),
    ).toEqual({
      selSongNo: '101300',
      selSongNoRaw: '101-300',
      naviGroupId: '101',
      title: 'Set The Tone',
      artist: 'aespa',
      tieupInfo: null,
      decision: 'drop',
      reason: 'foreign-korean',
      detailFlipRisk: false,
    });
  });

  it('drops a Han-only row (drop-han-only) with detailFlipRisk', () => {
    expect(
      buildJoysoundDecision(
        listItem({
          naviGroupId: '102',
          selSongNo: '102-400',
          songName: '起风了',
          artistName: '买辣椒也用券',
        }),
      ),
    ).toEqual({
      selSongNo: '102400',
      selSongNoRaw: '102-400',
      naviGroupId: '102',
      title: '起风了',
      artist: '买辣椒也用券',
      tieupInfo: null,
      decision: 'drop',
      reason: 'drop-han-only',
      detailFlipRisk: true,
    });
  });

  it('drops a Latin-only row (drop-ascii-only) with detailFlipRisk', () => {
    expect(
      buildJoysoundDecision(
        listItem({
          naviGroupId: '103',
          selSongNo: '103-500',
          songName: 'Generic Latin',
          artistName: 'LatinArtist',
        }),
      ),
    ).toEqual({
      selSongNo: '103500',
      selSongNoRaw: '103-500',
      naviGroupId: '103',
      title: 'Generic Latin',
      artist: 'LatinArtist',
      tieupInfo: null,
      decision: 'drop',
      reason: 'drop-ascii-only',
      detailFlipRisk: true,
    });
  });

  it('reviewed-allow override admits before the foreign-act gate and is not flip-risk', () => {
    // Production override lists ship empty, so inject the ALLOW seam to prove
    // the diagnostic surfaces a reviewed-allow verdict (matching the classifier
    // override path). reviewed-* is never flip-risk: the number is adjudicated.
    expect(
      buildJoysoundDecision(
        listItem({
          naviGroupId: '105',
          selSongNo: '105-700',
          songName: 'Set The Tone',
          artistName: 'aespa',
        }),
        {
          isDrop: () => false,
          isAllow: (n) => n === '105-700',
        },
      ),
    ).toEqual({
      selSongNo: '105700',
      selSongNoRaw: '105-700',
      naviGroupId: '105',
      title: 'Set The Tone',
      artist: 'aespa',
      tieupInfo: null,
      decision: 'admit',
      reason: 'reviewed-allow',
      detailFlipRisk: false,
    });
  });

  it('forwards a Korean foreign-name detail so the verdict flips to drop/foreign-korean', () => {
    // A kana-titled row that listing-only ADMITS as admit-jpop-kana (see the
    // next test). Supplying a detail whose artistNameForeign carries Hangul
    // is the authoritative foreign signal — the classifier's detail-gated
    // foreignNameSignal DROP gate fires and the verdict flips to foreign-korean.
    const row = listItem({
      naviGroupId: '200',
      selSongNo: '200-100',
      songName: 'カナタイトル',
      artistName: 'チョアン',
    });
    expect(
      buildJoysoundDecision(row, {
        detail: detail({ naviGroupId: '200', selSongNo: '200100', artistNameForeign: '조안' }),
      }),
    ).toEqual({
      selSongNo: '200100',
      selSongNoRaw: '200-100',
      naviGroupId: '200',
      title: 'カナタイトル',
      artist: 'チョアン',
      tieupInfo: null,
      decision: 'drop',
      reason: 'foreign-korean',
      // foreign-korean is never flip-risk: the detail already adjudicated it.
      detailFlipRisk: false,
    });
  });

  it('without detail the same kana row is unchanged (listing-only admit-jpop-kana)', () => {
    // Same row as above, but NO detail forwarded — the detail-gated gates stay
    // inert and the listing-only kana admit holds, proving detail is optional.
    expect(
      buildJoysoundDecision(
        listItem({
          naviGroupId: '200',
          selSongNo: '200-100',
          songName: 'カナタイトル',
          artistName: 'チョアン',
        }),
      ),
    ).toEqual({
      selSongNo: '200100',
      selSongNoRaw: '200-100',
      naviGroupId: '200',
      title: 'カナタイトル',
      artist: 'チョアン',
      tieupInfo: null,
      decision: 'admit',
      reason: 'admit-jpop-kana',
      detailFlipRisk: true,
    });
  });

  it('forwards an empty foreign-name detail so a Han-only row recovers to admit-jp-detail', () => {
    // A Han-only row listing-only DROPS as drop-han-only (Mandopop-ambiguous).
    // A detail with EMPTY foreign-name fields is the authoritative genuine-JP
    // verdict, so admit-jp-detail recovers it — proving detail enables the
    // recovery path the listing-only sweep cannot reach.
    const rec = buildJoysoundDecision(
      listItem({
        naviGroupId: '201',
        selSongNo: '201-200',
        songName: '夜桜',
        artistName: '宇多田光',
      }),
      { detail: detail({ naviGroupId: '201', selSongNo: '201200' }) },
    );
    expect(rec.decision).toBe('admit');
    expect(rec.reason).toBe('admit-jp-detail');
  });

  it('passes tieupInfo through unchanged and admits anime as not flip-risk', () => {
    const rec = buildJoysoundDecision(
      listItem({
        naviGroupId: '104',
        selSongNo: '104-600',
        songName: '紅蓮華',
        artistName: 'LiSA',
        tieupInfo: 'TVアニメ「鬼滅の刃」OP',
      }),
    );
    expect(rec.tieupInfo).toBe('TVアニメ「鬼滅の刃」OP');
    expect(rec.decision).toBe('admit');
    expect(rec.reason).toBe('admit-anime');
    expect(rec.detailFlipRisk).toBe(false);
  });
});
