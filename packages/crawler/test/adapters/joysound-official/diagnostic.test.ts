import { describe, expect, it } from 'vitest';
import { buildJoysoundDecision } from '../../../src/adapters/joysound-official/diagnostic.js';
import type { JoysoundListItem } from '../../../src/adapters/joysound-official/types.js';

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
      category: 'jpop',
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
      category: null,
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
      category: null,
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
      category: null,
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
      category: 'jpop',
      reason: 'reviewed-allow',
      detailFlipRisk: false,
    });
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
    expect(rec.category).toBe('anime');
    expect(rec.reason).toBe('admit-anime');
    expect(rec.detailFlipRisk).toBe(false);
  });
});
