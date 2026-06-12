import { describe, expect, it } from 'vitest';
import { classifyJoysoundRecordWithReason } from '../../../src/adapters/joysound-official/classifier.js';
import {
  REVIEWED_JOYSOUND_DROP_ENTRIES,
  isReviewedJoysoundAllow,
  isReviewedJoysoundDrop,
} from '../../../src/adapters/joysound-official/reviewedJoysoundOverrides.js';
import type {
  JoysoundDetail,
  JoysoundListItem,
} from '../../../src/adapters/joysound-official/types.js';

// A handful of representative ALLOW numbers from the 2026-06-09 full-catalog
// FP/FN adjudication sweep — K-pop/foreign acts' Japanese-language releases
// recovered from the FN stream and pinned at the exact JOYSOUND number.
const KNOWN_ALLOW = [
  '314666', // BTS — 進撃の防弾 -Japanese Ver.-
  '500883', // FTISLAND — アリガト
  '127170', // 東方神起 — 時ヲ止メテ
  '623552', // SawanoHiroyuki[nZk]:TOMORROW X TOGETHER — LEveL (2026-06-12 owner-approved recall recovery)
];

// The full adjudicated ALLOW set (sorted/deduped, byte-identical to the
// override-arrays.txt source artifact plus the 2026-06-12 owner-approved
// recall recovery `623552`). Mirrored here so the set-size-pin test asserts
// every number resolves AND the count is exactly 173 — an accidental edit to
// the source array (add/remove/typo) then fails CI.
const ALL_ALLOW_NUMBERS = [
  '102058',
  '108714',
  '119130',
  '119132',
  '119356',
  '119757',
  '127170',
  '128170',
  '129925',
  '136087',
  '136712',
  '137011',
  '138401',
  '139496',
  '139559',
  '145498',
  '146627',
  '156034',
  '160926',
  '169895',
  '176521',
  '178525',
  '196179',
  '20358',
  '27318',
  '29248',
  '29342',
  '29431',
  '29654',
  '29656',
  '31165',
  '314415',
  '314666',
  '315658',
  '31736',
  '32364',
  '423625',
  '425040',
  '428125',
  '430251',
  '432574',
  '436196',
  '436368',
  '436370',
  '436861',
  '437377',
  '437716',
  '438628',
  '439254',
  '441087',
  '442907',
  '444441',
  '444443',
  '444445',
  '444794',
  '445653',
  '446285',
  '446790',
  '446791',
  '449055',
  '485851',
  '485852',
  '486703',
  '487040',
  '490417',
  '493364',
  '493365',
  '493366',
  '493367',
  '493404',
  '494448',
  '494455',
  '494788',
  '500883',
  '611193',
  '611194',
  '612819',
  '613116',
  '613117',
  '613625',
  '614848',
  '615994',
  '618714',
  '619135',
  '619137',
  '620278',
  '623385',
  '623552',
  '625451',
  '625610',
  '628936',
  '629087',
  '629283',
  '632341',
  '632545',
  '634551',
  '636633',
  '636634',
  '638231',
  '641588',
  '643257',
  '643582',
  '644103',
  '671766',
  '673999',
  '674148',
  '674215',
  '674216',
  '675378',
  '675565',
  '675649',
  '675939',
  '681288',
  '681356',
  '682669',
  '683281',
  '684886',
  '685465',
  '689262',
  '691326',
  '696479',
  '696832',
  '718202',
  '720768',
  '720918',
  '721782',
  '722768',
  '722769',
  '722770',
  '722771',
  '722775',
  '722777',
  '722778',
  '723150',
  '723697',
  '723955',
  '724739',
  '725433',
  '726121',
  '728240',
  '728241',
  '728244',
  '728245',
  '729028',
  '729058',
  '730523',
  '730524',
  '730525',
  '730526',
  '731684',
  '732623',
  '732624',
  '732626',
  '732841',
  '736148',
  '736151',
  '736611',
  '737709',
  '83318',
  '85082',
  '86277',
  '90569',
  '91467',
  '918326',
  '91985',
  '93169',
  '93684',
  '93686',
  '93689',
  '94314',
  '94350',
  '94623',
  '94647',
];

describe('reviewedJoysoundOverrides — membership', () => {
  it('admits the adjudicated ALLOW sentinels', () => {
    for (const n of KNOWN_ALLOW) {
      expect(isReviewedJoysoundAllow(n), `ALLOW should contain ${n}`).toBe(true);
    }
  });

  it('normalizes hyphenated input to the same ALLOW hit', () => {
    // '314-666' must resolve identically to the bare '314666' (hyphen-stripped key).
    expect(isReviewedJoysoundAllow('314-666')).toBe(true);
    expect(isReviewedJoysoundAllow('314-666')).toBe(isReviewedJoysoundAllow('314666'));
  });

  it('drops the 2 Layer-3 precision-audit DROP numbers (bare and hyphenated)', () => {
    // 2026-06-12 Layer-3 400-row precision audit: the 2 admit-jp-detail FPs
    // with NO genreNames (so the 洋楽 veto cannot catch them).
    for (const n of ['154010', '488568', '154-010', '488-568']) {
      expect(isReviewedJoysoundDrop(n), `DROP should contain ${n}`).toBe(true);
    }
  });

  it('returns false from DROP for everything else', () => {
    for (const n of [...KNOWN_ALLOW, '314-666', '190001', '190-001', '900000', '12345', '']) {
      expect(isReviewedJoysoundDrop(n), `DROP should not contain ${n}`).toBe(false);
    }
  });

  it('returns false from both lists for a number that is not reviewed', () => {
    const absent = '999999999';
    expect(isReviewedJoysoundAllow(absent)).toBe(false);
    expect(isReviewedJoysoundDrop(absent)).toBe(false);
  });
});

describe('reviewedJoysoundOverrides — set size pin', () => {
  it('has exactly 173 ALLOW numbers (allow=173, drop=2)', () => {
    // The mirrored source-of-truth list is sorted + deduped at exactly 173.
    // 2026-06-10 CHECKPOINT 1 spot-check removed 148140 / 153397 / 735357
    // (Korean-language recordings, no genuine Japanese-market release).
    // 2026-06-12 owner-approved recall recovery added 623552 (LEveL /
    // SawanoHiroyuki[nZk]:TOMORROW X TOGETHER — Solo Leveling anime OP).
    expect(ALL_ALLOW_NUMBERS.length).toBe(173);
    expect(new Set(ALL_ALLOW_NUMBERS).size).toBe(173);
    // Every adjudicated number resolves through the public predicate, and none
    // is also on the DROP list — pins both the count and the partition so an
    // accidental edit to the override arrays fails CI.
    for (const n of ALL_ALLOW_NUMBERS) {
      expect(isReviewedJoysoundAllow(n), `ALLOW should contain ${n}`).toBe(true);
      expect(isReviewedJoysoundDrop(n), `DROP must not contain ALLOW number ${n}`).toBe(false);
    }
  });

  it('has exactly 2 DROP entries with non-empty audit metadata', () => {
    // 2026-06-12 Layer-3 400-row precision audit: pins the count, the exact
    // numbers, the metadata shape, and the ALLOW/DROP partition.
    expect(REVIEWED_JOYSOUND_DROP_ENTRIES.length).toBe(2);
    expect(REVIEWED_JOYSOUND_DROP_ENTRIES.map((e) => e.selSongNo).sort()).toEqual([
      '154010',
      '488568',
    ]);
    for (const entry of REVIEWED_JOYSOUND_DROP_ENTRIES) {
      expect(entry.title.length, `title must be non-empty for ${entry.selSongNo}`).toBeGreaterThan(
        0,
      );
      expect(
        entry.artist.length,
        `artist must be non-empty for ${entry.selSongNo}`,
      ).toBeGreaterThan(0);
      expect(entry.decidedOn).toBe('2026-06-12');
      expect(entry.note ?? '').toContain('precision audit');
      expect(
        isReviewedJoysoundDrop(entry.selSongNo),
        `DROP should contain ${entry.selSongNo}`,
      ).toBe(true);
      expect(
        isReviewedJoysoundAllow(entry.selSongNo),
        `ALLOW must not contain DROP number ${entry.selSongNo}`,
      ).toBe(false);
    }
  });
});

describe('reviewedJoysoundOverrides — hyphen normalization', () => {
  it('treats hyphenated and bare numbers identically', () => {
    expect(isReviewedJoysoundAllow('190-001')).toBe(isReviewedJoysoundAllow('190001'));
    expect(isReviewedJoysoundDrop('190-001')).toBe(isReviewedJoysoundDrop('190001'));
    expect(isReviewedJoysoundAllow(' 190-001 ')).toBe(isReviewedJoysoundAllow('190001'));
  });

  it('does not throw on empty / whitespace-only input', () => {
    expect(() => isReviewedJoysoundAllow('')).not.toThrow();
    expect(() => isReviewedJoysoundDrop('   ')).not.toThrow();
    expect(isReviewedJoysoundAllow('   ')).toBe(false);
  });
});

describe('reviewedJoysoundOverrides — classifier integration', () => {
  // BTS is a Korean act: without the override the foreign-act gate would drop
  // this row with reason `foreign-korean`. The curated ALLOW (consulted BEFORE
  // the foreign-act gate) must rescue it as `reviewed-allow`.
  const bts: JoysoundListItem = {
    naviGroupId: 'test-navi-314666',
    selSongNo: '314666',
    songName: '進撃の防弾 -Japanese Ver.-',
    artistName: 'BTS',
    artistId: null,
    tieupInfo: null,
    tieupId: null,
  };

  it('admits a reviewed-allow number via the `reviewed-allow` reason', () => {
    const verdict = classifyJoysoundRecordWithReason({ listItem: bts });
    expect(verdict.admit).toBe(true);
    expect(verdict.reason).toBe('reviewed-allow');
  });

  it('drops the same Korean act when it is NOT on the ALLOW list', () => {
    // Control: an un-reviewed BTS row falls to the foreign-act gate as expected,
    // proving the admit above is the override at work and not a positive gate.
    const verdict = classifyJoysoundRecordWithReason({
      listItem: { ...bts, selSongNo: '999999999' },
    });
    expect(verdict.admit).toBe(false);
    expect(verdict.reason).toBe('foreign-korean');
  });

  // The 2 Layer-3 precision-audit FPs: natively-Latin foreign rows whose detail
  // has empty foreign-name fields AND no genreNames — without the DROP override
  // the admit-jp-detail recovery would admit them (the 洋楽 veto has nothing to
  // veto on).
  const opmDetail: JoysoundDetail = {
    naviGroupId: 'test-navi-154010',
    songId: null,
    selSongNo: '154010',
    songName: 'KUNIN MO NA ANG LAHAT SA AKIN',
    songNameRuby: null,
    artistName: 'ANGELINE QUINTO',
    artistId: null,
    lyricist: null,
    composer: null,
    relDate: null,
    newFlg: null,
    lyricIntro: null,
    genreNames: [],
    tieupNames: [],
    aplServicePublishDates: [],
  };
  const opm: JoysoundListItem = {
    naviGroupId: 'test-navi-154010',
    selSongNo: '154010',
    songName: 'KUNIN MO NA ANG LAHAT SA AKIN',
    artistName: 'ANGELINE QUINTO',
    artistId: null,
    tieupInfo: null,
    tieupId: null,
  };

  it('drops a reviewed-drop number via the `reviewed-drop` reason (beats admit-jp-detail)', () => {
    const verdict = classifyJoysoundRecordWithReason({ listItem: opm, detail: opmDetail });
    expect(verdict.admit).toBe(false);
    expect(verdict.reason).toBe('reviewed-drop');
  });

  it('admits the same genre-less Latin row when it is NOT on the DROP list', () => {
    // Control: without the override the row recovers via admit-jp-detail,
    // proving the drop above is the override at work and not the 洋楽 veto.
    const verdict = classifyJoysoundRecordWithReason({
      listItem: { ...opm, selSongNo: '999999998' },
      detail: { ...opmDetail, selSongNo: '999999998' },
    });
    expect(verdict.admit).toBe(true);
    expect(verdict.reason).toBe('admit-jp-detail');
  });
});
