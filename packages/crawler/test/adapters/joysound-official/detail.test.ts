import { describe, expect, it } from 'vitest';
import { parseJoysoundDetail } from '../../../src/adapters/joysound-official/detail.js';

/**
 * `parseJoysoundDetail` accepts the parsed JSON body of
 * `https://www.joysound.com/apis/v1/ise/fetchContentsDetail?kind=naviGroupId&id=<naviGroupId>`.
 * The detail API wraps the song record in different shapes in the wild — the
 * parser tolerates both a direct object and an envelope.
 */

describe('parseJoysoundDetail — happy path', () => {
  it('extracts required fields from a flat detail object', () => {
    const value = {
      naviGroupId: '190001',
      songId: '11111',
      selSongNo: '190-001',
      songName: '夜に駆ける',
      songNameRuby: 'よるにかける',
      artistInfo: { artistName: 'YOASOBI', artistId: '7777' },
      lyricist: 'Ayase',
      composer: 'Ayase',
      relDate: '2019-12-15',
      newFlg: '1',
      lyricIntro: '沈むように溶けてゆくように',
      genreList: [
        { genreId: '1', genreName: 'JPOP' },
        { genreId: '2', genreName: 'POPS' },
      ],
      tieupList: [],
      aplList: [],
    };

    const detail = parseJoysoundDetail(value);

    expect(detail).toEqual({
      naviGroupId: '190001',
      songId: '11111',
      selSongNo: '190-001',
      songName: '夜に駆ける',
      songNameRuby: 'よるにかける',
      artistName: 'YOASOBI',
      artistId: '7777',
      lyricist: 'Ayase',
      composer: 'Ayase',
      relDate: '2019-12-15',
      newFlg: '1',
      lyricIntro: '沈むように溶けてゆくように',
      genreNames: ['JPOP', 'POPS'],
      tieupNames: [],
      aplServicePublishDates: [],
    });
  });

  it('surfaces top-level songNameForeign and artistInfo.artistNameForeign', () => {
    const value = {
      naviGroupId: '190010',
      selSongNo: '190-010',
      songName: 'Song',
      songNameForeign: String.fromCodePoint(0x8d77, 0x98ce), // Han-only foreign title
      artistInfo: {
        artistName: 'Artist',
        artistId: '1',
        artistNameForeign: String.fromCodePoint(0xd55c, 0xae00), // Hangul foreign artist
      },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.songNameForeign).toBe(String.fromCodePoint(0x8d77, 0x98ce));
    expect(detail.artistNameForeign).toBe(String.fromCodePoint(0xd55c, 0xae00));
  });

  it('leaves foreign-name fields undefined when absent or empty', () => {
    const value = {
      naviGroupId: '190011',
      selSongNo: '190-011',
      songName: 'Song',
      songNameForeign: '',
      artistInfo: { artistName: 'Artist', artistNameForeign: '$undefined' },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.songNameForeign).toBeUndefined();
    expect(detail.artistNameForeign).toBeUndefined();
  });

  it('surfaces top-level songNameForeignSearch and artistInfo.artistNameForeignSearch (C1 romanization)', () => {
    const value = {
      naviGroupId: '190012',
      selSongNo: '190-012',
      songName: 'Song',
      songNameForeignSearch: 'wu.lai.', // dotted pinyin
      artistInfo: { artistName: 'Artist', artistNameForeignSearch: 'zhang.xue.you.' },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.songNameForeignSearch).toBe('wu.lai.');
    expect(detail.artistNameForeignSearch).toBe('zhang.xue.you.');
  });

  it('leaves *ForeignSearch fields undefined when absent or empty', () => {
    const value = {
      naviGroupId: '190013',
      selSongNo: '190-013',
      songName: 'Song',
      songNameForeignSearch: '',
      artistInfo: { artistName: 'Artist', artistNameForeignSearch: '$undefined' },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.songNameForeignSearch).toBeUndefined();
    expect(detail.artistNameForeignSearch).toBeUndefined();
  });

  it('honors top-level artistNameForeignSearch as a fallback when artistInfo lacks it', () => {
    const value = {
      naviGroupId: '190014',
      selSongNo: '190-014',
      songName: 'Song',
      artistNameForeignSearch: 'top.level.',
      artistInfo: { artistName: 'Artist' },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.artistNameForeignSearch).toBe('top.level.');
  });

  it('flattens tieupList[].tieupName and aplList[].selectionList[].ServicePublishDate', () => {
    // Mirrors the real API shape (verified against raw fetchContentsDetail
    // dumps): genre/tieup entries carry list-prefixed keys, and the publish
    // date lives on selectionList entries nested inside aplList items.
    const value = {
      naviGroupId: '190002',
      songId: null,
      selSongNo: '190-002',
      songName: 'アイドル',
      artistInfo: { artistName: 'YOASOBI', artistId: '7777' },
      tieupList: [
        { tieupId: 't1', tieupName: 'アニメ「【推しの子】」OP', tieupNameRuby: 'オシノコ' },
        { tieupId: 't2', tieupName: '映画版OP' },
      ],
      aplList: [
        { aplId: '0000100', hitCount: '0', selectionList: [] },
        {
          aplId: '0000800',
          hitCount: '2',
          selectionList: [
            { selSongNo: '190002', ServicePublishDate: '20230412000000' },
            { selSongNo: '190002', ServicePublishDate: '20240105000000' },
          ],
        },
      ],
      genreList: [{ genreId: 'g1', genreName: 'ANISON' }],
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.tieupNames).toEqual(['アニメ「【推しの子】」OP', '映画版OP']);
    expect(detail.aplServicePublishDates).toEqual(['20230412000000', '20240105000000']);
    expect(detail.genreNames).toEqual(['ANISON']);
  });

  it('does NOT pick up the legacy wrong keys ({name} entries, item-level apl dates)', () => {
    // Regression pin for the 2026-06 parser bug: flattenNames used to read
    // `item.name` (a key the API never emits) and flattenAplDates used to read
    // an item-level `selectionServicePublishDate` (also nonexistent). Entries
    // shaped that way must stay invisible; the real keys must be honored.
    const value = {
      naviGroupId: '190003',
      selSongNo: '190-003',
      songName: 'X',
      artistInfo: { artistName: 'Y' },
      genreList: [{ name: 'ロック' }, { genreId: 'g1', genreName: 'アニメ' }],
      tieupList: [{ name: '妖怪ウォッチ' }],
      aplList: [
        { selectionServicePublishDate: '2023-04-12' },
        { selectionList: [{ selectionServicePublishDate: '2024-01-05' }] },
      ],
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.genreNames).toEqual(['アニメ']); // {name: 'ロック'} skipped
    expect(detail.tieupNames).toEqual([]); // {name: ...} must not silently work
    expect(detail.aplServicePublishDates).toEqual([]); // wrong key at both levels
  });

  it('coerces finite numeric IDs to strings', () => {
    const value = {
      naviGroupId: 190005,
      songId: 33333,
      selSongNo: '190-005',
      songName: 'X',
      artistInfo: { artistName: 'Y', artistId: 9999 },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.naviGroupId).toBe('190005');
    expect(detail.songId).toBe('33333');
    expect(detail.artistId).toBe('9999');
  });

  it('unwraps a common envelope shape ({ data: {...} } or { detail: {...} })', () => {
    const envelope = {
      data: {
        naviGroupId: '190006',
        songId: null,
        selSongNo: '190-006',
        songName: 'EnvSong',
        artistInfo: { artistName: 'EnvArtist', artistId: null },
      },
    };

    const detail = parseJoysoundDetail(envelope);

    expect(detail.naviGroupId).toBe('190006');
    expect(detail.songName).toBe('EnvSong');
    expect(detail.artistName).toBe('EnvArtist');
  });

  it('defaults optional string fields to null and list fields to empty arrays', () => {
    const value = {
      naviGroupId: '190007',
      selSongNo: '190-007',
      songName: 'Bare',
      artistInfo: { artistName: 'Solo' },
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.songId).toBeNull();
    expect(detail.songNameRuby).toBeNull();
    expect(detail.artistId).toBeNull();
    expect(detail.lyricist).toBeNull();
    expect(detail.composer).toBeNull();
    expect(detail.relDate).toBeNull();
    expect(detail.newFlg).toBeNull();
    expect(detail.lyricIntro).toBeNull();
    expect(detail.genreNames).toEqual([]);
    expect(detail.tieupNames).toEqual([]);
    expect(detail.aplServicePublishDates).toEqual([]);
  });
});

describe('parseJoysoundDetail — error path', () => {
  it('throws when the value is not an object', () => {
    expect(() => parseJoysoundDetail(null)).toThrow();
    expect(() => parseJoysoundDetail('hello')).toThrow();
    expect(() => parseJoysoundDetail(42)).toThrow();
    expect(() => parseJoysoundDetail([])).toThrow();
  });

  it('throws when any required field is missing or unstringable', () => {
    expect(() =>
      parseJoysoundDetail({
        selSongNo: '1',
        songName: 'x',
      }),
    ).toThrow(/naviGroupId/);
    expect(() =>
      parseJoysoundDetail({
        naviGroupId: '1',
        songName: 'x',
      }),
    ).toThrow(/selSongNo/);
    expect(() =>
      parseJoysoundDetail({
        naviGroupId: '1',
        selSongNo: '1',
      }),
    ).toThrow(/songName/);
  });
});
