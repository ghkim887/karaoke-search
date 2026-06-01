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
      genreList: [{ name: 'JPOP' }, { name: 'POPS' }],
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

  it('flattens tieupList[].name and aplList[].selectionServicePublishDate', () => {
    const value = {
      naviGroupId: '190002',
      songId: null,
      selSongNo: '190-002',
      songName: 'アイドル',
      artistInfo: { artistName: 'YOASOBI', artistId: '7777' },
      tieupList: [{ name: 'アニメ「【推しの子】」OP' }, { name: '映画版OP' }],
      aplList: [
        { selectionServicePublishDate: '2023-04-12' },
        { selectionServicePublishDate: '2024-01-05' },
      ],
      genreList: [{ name: 'ANISON' }],
    };

    const detail = parseJoysoundDetail(value);

    expect(detail.tieupNames).toEqual(['アニメ「【推しの子】」OP', '映画版OP']);
    expect(detail.aplServicePublishDates).toEqual(['2023-04-12', '2024-01-05']);
    expect(detail.genreNames).toEqual(['ANISON']);
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
