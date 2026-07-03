import type { KaraokeNumbers, SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { buildOfflineRecallIndex } from './offline-recall.js';

function makeRecord(
  id: string,
  overrides: Omit<Partial<SongRecord>, 'karaoke_numbers'> & {
    karaoke_numbers?: Partial<KaraokeNumbers>;
  } = {},
): SongRecord {
  const { karaoke_numbers, ...rest } = overrides;
  return {
    id,
    source_url: 'https://example.test/song',
    title_primary: 'Title',
    title_ko: null,
    artist_primary: 'Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null, ...(karaoke_numbers ?? {}) },
    crawled_at: '2026-06-13T00:00:00.000Z',
    ...rest,
  };
}

describe('offline-recall: karaoke-number queries', () => {
  it('returns null for a non-number query (falls through to text)', () => {
    const index = buildOfflineRecallIndex([makeRecord('a', { karaoke_numbers: { tj: '12345' } })]);
    expect(index.matchNumberQuery('yoasobi')).toBeNull();
    expect(index.matchNumberQuery('紅蓮華')).toBeNull();
  });

  it('matches an exact catalog number', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('hit', { karaoke_numbers: { tj: '68381' } }),
      makeRecord('miss', { karaoke_numbers: { tj: '99999' } }),
    ]);
    expect(index.matchNumberQuery('68381')).toEqual(['hit']);
  });

  it('ranks an exact match above a longer prefix match', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('prefix', { karaoke_numbers: { tj: '683810' } }),
      makeRecord('exact', { karaoke_numbers: { tj: '68381' } }),
    ]);
    // Exact (68381) outscores the prefix-only 683810 despite later array order.
    expect(index.matchNumberQuery('68381')).toEqual(['exact', 'prefix']);
  });

  it('matches a numeric prefix and orders ties by corpus position', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('first', { karaoke_numbers: { tj: '68400' } }),
      makeRecord('second', { karaoke_numbers: { ky: '68450' } }),
      makeRecord('other', { karaoke_numbers: { tj: '70000' } }),
    ]);
    expect(index.matchNumberQuery('684')).toEqual(['first', 'second']);
  });

  it('matches leading-zero numbers via number_key', () => {
    // Stored "068381" != "68381" exactly, but its number_key ("68381") matches.
    const index = buildOfflineRecallIndex([
      makeRecord('zero', { karaoke_numbers: { tj: '068381' } }),
    ]);
    expect(index.matchNumberQuery('68381')).toEqual(['zero']);
  });

  it('scopes a provider-prefixed query (tj68381) to that provider', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('tjsong', { karaoke_numbers: { tj: '68381' } }),
      makeRecord('kysong', { karaoke_numbers: { ky: '68381' } }),
    ]);
    expect(index.matchNumberQuery('tj68381')).toEqual(['tjsong']);
    expect(index.matchNumberQuery('ky68381')).toEqual(['kysong']);
  });

  it('scopes matches to the selected vendors', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('tjonly', { karaoke_numbers: { tj: '68381' } }),
      // Queried number is on TJ, but this song's KY number differs — must NOT
      // appear when the vendor scope is {ky}, mirroring the worker.
      makeRecord('tjhit-kyother', { karaoke_numbers: { tj: '68381', ky: '11111' } }),
      makeRecord('kyhit', { karaoke_numbers: { ky: '68381' } }),
    ]);
    expect(index.matchNumberQuery('68381', new Set(['ky']))).toEqual(['kyhit']);
    expect(index.matchNumberQuery('68381', new Set(['tj']))).toEqual(['tjonly', 'tjhit-kyother']);
  });

  it('treats an empty vendor scope as no filter (matches all providers)', () => {
    // No vendor chip selected: the app passes an empty Set, which must behave
    // like `filterByVendors` (no-op), NOT reject every provider.
    const index = buildOfflineRecallIndex([
      makeRecord('tjsong', { karaoke_numbers: { tj: '68381' } }),
      makeRecord('kysong', { karaoke_numbers: { ky: '68381' } }),
    ]);
    expect(index.matchNumberQuery('68381', new Set())).toEqual(['tjsong', 'kysong']);
  });
});

describe('offline-recall: Hangul-initials queries', () => {
  it('returns null for a non-initials query', () => {
    const index = buildOfflineRecallIndex([makeRecord('a', { title_ko: '밤을 달리다' })]);
    expect(index.matchInitialsQuery('yoasobi')).toBeNull();
    expect(index.matchInitialsQuery('밤을')).toBeNull(); // syllables keep the text path
    expect(index.matchInitialsQuery('ㄱ')).toBeNull(); // single jamo below the 2-char floor
  });

  it('matches choseong of title_ko / artist_ko as a prefix', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('yoru', { title_ko: '밤을 달리다', artist_ko: '요아소비' }),
      makeRecord('other', { title_ko: '홍련화', artist_ko: '리세' }),
    ]);
    // 밤을 달리다 -> ㅂㅇㄷㄹㄷ ; prefix ㅂㅇ matches.
    expect(index.matchInitialsQuery('ㅂㅇ')).toEqual(['yoru']);
    // 홍련화 -> ㅎㄹㅎ ; exact.
    expect(index.matchInitialsQuery('ㅎㄹㅎ')).toEqual(['other']);
  });

  it('collapses interior spaces into one initial token ("ㅂㅇ ㄷㄹ" == "ㅂㅇㄷㄹ")', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('yoru', { title_ko: '밤을 달리다' }), // -> ㅂㅇㄷㄹㄷ
    ]);
    // A spaced choseong query must match identically to the concatenated form,
    // converging with the worker (whose makeHangulInitials drops the space).
    expect(index.matchInitialsQuery('ㅂㅇ ㄷㄹ')).toEqual(['yoru']);
    expect(index.matchInitialsQuery('ㅂㅇ ㄷㄹ')).toEqual(index.matchInitialsQuery('ㅂㅇㄷㄹ'));
  });

  it('does not fire for a mixed choseong + Latin query (keeps the text path)', () => {
    const index = buildOfflineRecallIndex([makeRecord('a', { title_ko: '밤을 달리다' })]);
    expect(index.matchInitialsQuery('ㅂㅇ dr')).toBeNull();
  });

  it('ranks a title-field match above an artist-only match', () => {
    const index = buildOfflineRecallIndex([
      makeRecord('artistMatch', { artist_ko: '나다라' }),
      makeRecord('titleMatch', { title_ko: '나다라' }),
    ]);
    // Both match ㄴㄷㄹ; the title field (weight 5) outranks the artist (weight 3).
    expect(index.matchInitialsQuery('ㄴㄷㄹ')).toEqual(['titleMatch', 'artistMatch']);
  });
});
