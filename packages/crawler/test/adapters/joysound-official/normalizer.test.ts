import { describe, expect, it } from 'vitest';
import {
  normalizeJoysoundNumber,
  normalizeJoysoundRecord,
} from '../../../src/adapters/joysound-official/normalizer.js';
import type {
  JoysoundDetail,
  JoysoundListItem,
} from '../../../src/adapters/joysound-official/types.js';

const SOURCE_URL = 'https://www.joysound.com/web/search/song/190001';
const CRAWLED_AT = '2026-05-31T00:00:00.000Z';

function listItem(over: Partial<JoysoundListItem> = {}): JoysoundListItem {
  return {
    naviGroupId: '190001',
    selSongNo: '190-001',
    songName: '夜に駆ける',
    artistName: 'YOASOBI',
    artistId: '7777',
    tieupInfo: null,
    tieupId: null,
    ...over,
  };
}

function detail(over: Partial<JoysoundDetail> = {}): JoysoundDetail {
  return {
    naviGroupId: '190001',
    songId: null,
    selSongNo: '190-001',
    songName: '夜に駆ける',
    songNameRuby: 'よるにかける',
    artistName: 'YOASOBI',
    artistId: '7777',
    lyricist: 'Ayase',
    composer: 'Ayase',
    relDate: null,
    newFlg: null,
    lyricIntro: null,
    genreNames: [],
    tieupNames: [],
    aplServicePublishDates: [],
    ...over,
  };
}

describe('normalizeJoysoundRecord — record shape', () => {
  it('builds the id as joysound-${naviGroupId}', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem(),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.id).toBe('joysound-190001');
  });

  it('threads sourceUrl and crawledAt through', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem(),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.source_url).toBe(SOURCE_URL);
    expect(rec.crawled_at).toBe(CRAWLED_AT);
  });

  it('puts the dashless selSongNo into karaoke_numbers.joysound, leaving tj/ky null', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ selSongNo: '190-001' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.karaoke_numbers).toEqual({ tj: null, ky: null, joysound: '190001' });
  });

  it('strips hyphens from selSongNo so karaoke_numbers.joysound is bare digits (Tier-A union with blog)', () => {
    // 900-000 → 900000: matches the dashless blog corpus joysound numbers.
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ selSongNo: '900-000' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.karaoke_numbers.joysound).toBe('900000');
  });

  it('uses the passed category as the single categories entry', () => {
    for (const c of ['jpop', 'anime', 'vocaloid'] as const) {
      const rec = normalizeJoysoundRecord({
        listItem: listItem(),
        category: c,
        sourceUrl: SOURCE_URL,
        crawledAt: CRAWLED_AT,
      });
      expect(rec.categories).toEqual([c]);
    }
  });
});

describe('normalizeJoysoundRecord — title / artist', () => {
  it('prefers detail.songName when both listItem and detail are present', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ songName: 'fallback title' }),
      detail: detail({ songName: 'detail title' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.title_primary).toBe('detail title');
  });

  it('prefers detail.artistName when both listItem and detail are present', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ artistName: 'fallback artist' }),
      detail: detail({ artistName: 'detail artist' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.artist_primary).toBe('detail artist');
  });

  it('falls back to listItem.songName / listItem.artistName when no detail is supplied', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ songName: 'L Song', artistName: 'L Artist' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.title_primary).toBe('L Song');
    expect(rec.artist_primary).toBe('L Artist');
  });

  it('falls back to listItem.artistName when detail.artistName is null', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ artistName: 'List Artist' }),
      detail: detail({ artistName: null }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.artist_primary).toBe('List Artist');
  });
});

describe('normalizeJoysoundRecord — invariants (no Korean fields)', () => {
  it('forces title_ko = null even when detail.songNameRuby is populated', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem(),
      detail: detail({ songNameRuby: 'よるにかける' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.title_ko).toBeNull();
  });

  it('forces artist_ko = null', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem(),
      detail: detail(),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.artist_ko).toBeNull();
  });

  it('emits karaoke_numbers with only the joysound field populated (dashless)', () => {
    const rec = normalizeJoysoundRecord({
      listItem: listItem({ selSongNo: '500-123' }),
      detail: detail({ selSongNo: '500-123' }),
      category: 'jpop',
      sourceUrl: SOURCE_URL,
      crawledAt: CRAWLED_AT,
    });
    expect(rec.karaoke_numbers.tj).toBeNull();
    expect(rec.karaoke_numbers.ky).toBeNull();
    expect(rec.karaoke_numbers.joysound).toBe('500123');
  });
});

describe('normalizeJoysoundNumber', () => {
  it('strips all hyphens from a hyphenated JOYSOUND number', () => {
    expect(normalizeJoysoundNumber('190-001')).toBe('190001');
    expect(normalizeJoysoundNumber('900-000')).toBe('900000');
  });

  it('passes through an already-dashless number unchanged', () => {
    expect(normalizeJoysoundNumber('190001')).toBe('190001');
  });

  it('throws when the stripped value is not non-empty digits', () => {
    expect(() => normalizeJoysoundNumber('---')).toThrow();
    expect(() => normalizeJoysoundNumber('19a-001')).toThrow();
    expect(() => normalizeJoysoundNumber('')).toThrow();
  });
});

describe('normalizeJoysoundRecord — validation', () => {
  it('throws when listItem.selSongNo is empty', () => {
    expect(() =>
      normalizeJoysoundRecord({
        listItem: listItem({ selSongNo: '' }),
        category: 'jpop',
        sourceUrl: SOURCE_URL,
        crawledAt: CRAWLED_AT,
      }),
    ).toThrow();
  });

  it('throws when listItem.naviGroupId is empty', () => {
    expect(() =>
      normalizeJoysoundRecord({
        listItem: listItem({ naviGroupId: '' }),
        category: 'jpop',
        sourceUrl: SOURCE_URL,
        crawledAt: CRAWLED_AT,
      }),
    ).toThrow();
  });
});
