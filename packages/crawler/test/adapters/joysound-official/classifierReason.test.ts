import { describe, expect, it } from 'vitest';
import { classifyJoysoundRecordWithReason } from '../../../src/adapters/joysound-official/classifier.js';
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

describe('classifyJoysoundRecordWithReason — gate reasons', () => {
  it('admit-vocaloid for 初音ミク artist', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ artistName: '初音ミク', songName: '千本桜' }),
      }),
    ).toEqual({ category: 'vocaloid', reason: 'admit-vocaloid' });
  });

  it('admit-anime for アニメ tieup', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({
          songName: '紅蓮華',
          artistName: 'LiSA',
          tieupInfo: 'TVアニメ「鬼滅の刃」OP',
        }),
      }),
    ).toEqual({ category: 'anime', reason: 'admit-anime' });
  });

  it('admit-jpop-kana for a pure-kana title', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'よるにかける', artistName: 'YOASOBI' }),
      }),
    ).toEqual({ category: 'jpop', reason: 'admit-jpop-kana' });
  });

  it('foreign-korean for a known Korean act', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Set The Tone', artistName: 'aespa' }),
      }),
    ).toEqual({ category: null, reason: 'foreign-korean' });
  });

  it('foreign-western for a known Western act', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'WE WILL ROCK YOU', artistName: 'QUEEN' }),
      }),
    ).toEqual({ category: null, reason: 'foreign-western' });
  });

  it('drop-han-only for a Han-but-no-kana title/artist', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: '起风了', artistName: '买辣椒也用券' }),
      }),
    ).toEqual({ category: null, reason: 'drop-han-only' });
  });

  it('drop-ascii-only for a Latin-only title/artist', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Generic Latin', artistName: 'LatinArtist' }),
      }),
    ).toEqual({ category: null, reason: 'drop-ascii-only' });
  });

  it('drop-no-signal when title/artist carries neither Han nor Latin nor kana', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: '?!', artistName: '???' }),
      }),
    ).toEqual({ category: null, reason: 'drop-no-signal' });
  });
});

describe('classifyJoysoundRecordWithReason — override paths', () => {
  // The production override sets ship EMPTY, so live ALLOW/DROP hits are
  // exercised by injecting the predicate seam (`overrides`) the classifier
  // exposes for exactly this reason. This keeps the classifier the single
  // source of truth while still proving the precedence rules. The seam passes
  // the raw `listItem.selSongNo`, matching the production predicates that
  // normalize (hyphen-strip) internally — so stubs match the raw form.
  it('reviewed-drop wins first, before any admit gate', () => {
    // A row that would normally admit-vocaloid is force-dropped by the DROP
    // override.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ artistName: '初音ミク', songName: '千本桜', selSongNo: '111-111' }),
        overrides: {
          isDrop: (n) => n === '111-111',
          isAllow: () => false,
        },
      }),
    ).toEqual({ category: null, reason: 'reviewed-drop' });
  });

  it('reviewed-allow admits a Korean act before the foreign-act gate fires', () => {
    // aespa would normally drop foreign-korean; an exact-number ALLOW pins it
    // in. With no kana/anime/vocaloid signal it falls back to jpop.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Set The Tone', artistName: 'aespa', selSongNo: '222-222' }),
        overrides: {
          isDrop: () => false,
          isAllow: (n) => n === '222-222',
        },
      }),
    ).toEqual({ category: 'jpop', reason: 'reviewed-allow' });
  });

  it('reviewed-allow keeps the best normal-gate category (anime/vocaloid) when present', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({
          songName: '紅蓮華',
          artistName: 'aespa',
          tieupInfo: 'TVアニメ「X」OP',
          selSongNo: '333-333',
        }),
        overrides: {
          isDrop: () => false,
          isAllow: (n) => n === '333-333',
        },
      }),
    ).toEqual({ category: 'anime', reason: 'reviewed-allow' });
  });

  it('with empty production overrides, the layer is a no-op', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Set The Tone', artistName: 'aespa', selSongNo: '900-000' }),
      }).reason,
    ).toBe('foreign-korean');
  });
});
