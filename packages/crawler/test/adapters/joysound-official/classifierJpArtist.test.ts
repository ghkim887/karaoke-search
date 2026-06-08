import { describe, expect, it } from 'vitest';
import {
  classifyJoysoundRecord,
  classifyJoysoundRecordWithReason,
} from '../../../src/adapters/joysound-official/classifier.js';
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

/**
 * FIX F2 regression — the sweep found 25,097 dropped rows whose artist is a
 * confirmed Japanese act, dropped only because neither title nor artist has
 * kana (kanji-only or ASCII title). The sweep layer injects an optional
 * `isKnownJapaneseArtist` predicate (built from the corpus) so those rows admit
 * as `jpop` via the new `admit-jp-artist` reason — mirroring TJ's
 * `jpn-admit-artist` recall path. The production crawler injects nothing, so
 * its behavior is unchanged.
 */
describe('classifyJoysoundRecordWithReason — injected JP-artist admit path (F2)', () => {
  it('admits a Han-only-title row by a corpus JP artist as admit-jp-artist', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: '感電', artistName: '米津玄師' }),
        isKnownJapaneseArtist: (a) => a === '米津玄師',
      }),
    ).toEqual({ category: 'jpop', reason: 'admit-jp-artist' });
  });

  it('admits an ASCII-only-title row by a corpus JP artist as admit-jp-artist', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'Pretender', artistName: 'Official髭男dism' }),
        isKnownJapaneseArtist: (a) => a === 'Official髭男dism',
      }),
    ).toEqual({ category: 'jpop', reason: 'admit-jp-artist' });
  });

  it('the foreign-act gate WINS over the JP-artist admit path', () => {
    // BoA appears in the corpus (her Japanese releases) but is a foreign act.
    // Even with an injected predicate that would admit her, the foreign gate
    // must drop the row first.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'なみだ', artistName: 'aespa' }),
        isKnownJapaneseArtist: () => true,
      }),
    ).toEqual({ category: null, reason: 'foreign-korean' });
  });

  it('a positive kana/anime/vocaloid signal still wins over the JP-artist path', () => {
    // A kana title would admit-jpop-kana on its own — the predicate must not
    // downgrade or shadow the stronger positive gate.
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: 'よるにかける', artistName: 'YOASOBI' }),
        isKnownJapaneseArtist: () => true,
      }),
    ).toEqual({ category: 'jpop', reason: 'admit-jpop-kana' });
  });

  it('does NOT admit when the predicate says the artist is unknown', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: '感電', artistName: '無名歌手' }),
        isKnownJapaneseArtist: () => false,
      }),
    ).toEqual({ category: null, reason: 'drop-han-only' });
  });

  it('with NO predicate injected, a Han-only row still drops (production unchanged)', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ songName: '感電', artistName: '米津玄師' }),
      }),
    ).toEqual({ category: null, reason: 'drop-han-only' });

    expect(
      classifyJoysoundRecord({
        listItem: listItem({ songName: '感電', artistName: '米津玄師' }),
      }),
    ).toBeNull();
  });
});
