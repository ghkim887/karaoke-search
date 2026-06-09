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

/**
 * FIX F1 regression — the full-catalog sweep found 140 admitted rows by 12
 * foreign acts the classifier's narrow Korean/Western lists MISSED. Each has a
 * katakana song title so `admit-jpop-kana` fired even though the ARTIST is
 * foreign. The fix makes the foreign-act gate ALSO consult the production
 * Korean + Chinese drop lists (the same matchers the TJ filter chain uses), so
 * the classifier stops drifting from the audit's `isAuditForeignAct`.
 *
 * Every row below carries a kana title (`admit-jpop-kana` bait); the gate must
 * still drop them with a foreign reason.
 */
describe('classifyJoysoundRecordWithReason — production drop-list foreign-act gate (F1)', () => {
  // Korean drop-list members (foreign-korean).
  it.each([
    ['IZ*ONE', 'すきだといって'],
    ['FTISLAND', 'となりのあなた'],
    ['イ・ホンギ from FTISLAND', 'こころ'],
    ['J-Walk', 'なみだ'],
    ['J-Walk Feat.ウンジウォン', 'なみだ'],
    ['AKMU', 'ことば'],
    ['PLAVE', 'ひかり'],
  ] as const)('drops Korean drop-list act %s as foreign-korean', (artistName, songName) => {
    expect(
      classifyJoysoundRecordWithReason({ listItem: listItem({ artistName, songName }) }),
    ).toEqual({ admit: false, reason: 'foreign-korean' });
  });

  // Chinese drop-list members (foreign-chinese).
  it.each([
    ['S.H.E', 'なみだ'],
    ['TWINS', 'さくら'],
    ['BEYOND', 'ひかり'],
    ['F4', 'ことば'],
    ['B.A.D', 'こころ'],
  ] as const)('drops Chinese drop-list act %s as foreign-chinese', (artistName, songName) => {
    expect(
      classifyJoysoundRecordWithReason({ listItem: listItem({ artistName, songName }) }),
    ).toEqual({ admit: false, reason: 'foreign-chinese' });
  });

  it('still admits a genuine Japanese act whose name is not on any drop list', () => {
    expect(
      classifyJoysoundRecordWithReason({
        listItem: listItem({ artistName: 'YOASOBI', songName: 'よるにかける' }),
      }),
    ).toEqual({ admit: true, reason: 'admit-jpop-kana' });
  });
});
