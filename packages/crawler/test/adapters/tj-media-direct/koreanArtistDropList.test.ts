import { describe, expect, it } from 'vitest';
import {
  DROP_KEY_SET,
  DROP_LIST,
  isInDropList,
} from '../../../src/adapters/tj-media-direct/koreanArtistDropList.js';
import { normalizeForMatch } from '../../../src/adapters/tj-media-direct/normalize.js';

describe('koreanArtistDropList — Phase 1 §2.E seed list', () => {
  it('exports at least 20 canonical entries (spec §2.E target)', () => {
    expect(DROP_LIST.length).toBeGreaterThanOrEqual(20);
  });

  it('every variant in every entry normalizes to a non-empty key', () => {
    for (const entry of DROP_LIST) {
      expect(entry.variants.length).toBeGreaterThan(0);
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        expect(key).not.toBe('');
      }
    }
  });

  it('DROP_KEY_SET contains the normalized form of every variant', () => {
    for (const entry of DROP_LIST) {
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        expect(DROP_KEY_SET.has(key)).toBe(true);
      }
    }
  });

  it('DROP_KEY_SET size is at least the count of distinct variant keys', () => {
    // Each entry contributes its variants; cross-entry collisions would be a
    // data error worth surfacing.
    const seen = new Set<string>();
    for (const entry of DROP_LIST) {
      for (const variant of entry.variants) {
        seen.add(normalizeForMatch(variant));
      }
    }
    expect(DROP_KEY_SET.size).toBe(seen.size);
  });
});

describe('isInDropList — true positives (known leakers from spec §2.E)', () => {
  function check(name: string): void {
    expect(isInDropList(normalizeForMatch(name))).toBe(true);
  }

  it('catches BTS variants (Hangul, Latin, kanji)', () => {
    check('방탄소년단');
    check('BTS');
    check('防弾少年団');
    check('SUGA of BTS');
  });

  it("catches Girls' Generation variants", () => {
    check('소녀시대');
    check('少女時代');
    check('SNSD');
    check("Girls' Generation");
    check('Girls Generation');
  });

  it('catches TVXQ variants (the largest pre-fix kanji-script leaker)', () => {
    check('동방신기');
    check('東方神起');
    check('TVXQ');
    check('Tohoshinki');
  });

  it('catches FT Island variants', () => {
    check('FT Island');
    check('FTISLAND');
    check('에프티 아일랜드');
    check('에프티아일랜드');
  });

  it('catches EXO-CBX (survives the §2.A threshold via ratio 1.0 — drop list is the safety net)', () => {
    check('EXO-CBX');
    check('EXO');
    check('엑소');
  });

  it('catches BIGBANG, SHINee, BLACKPINK', () => {
    check('BIGBANG');
    check('빅뱅');
    check('SHINee');
    check('샤이니');
    check('BLACKPINK');
    check('블랙핑크');
  });

  it('catches the §2.E non-group leakers (Park Hyo Shin, Lump, IU)', () => {
    check('박효신');
    check('Park Hyo Shin');
    check('램프');
    check('Lump');
    check('IU');
    check('아이유');
  });

  it('normalization handles whitespace + case variants', () => {
    expect(isInDropList(normalizeForMatch('  bts  '))).toBe(true);
    expect(isInDropList(normalizeForMatch('Blackpink'))).toBe(true);
    expect(isInDropList(normalizeForMatch('GIRLS GENERATION'))).toBe(true);
  });
});

describe('isInDropList — true negatives (real Japanese acts must not match)', () => {
  function check(name: string): void {
    expect(isInDropList(normalizeForMatch(name))).toBe(false);
  }

  it('does not catch LiSA (real JP, similar surface form to "List")', () => {
    check('LiSA');
  });

  it('does not catch SEKAI NO OWARI', () => {
    check('SEKAI NO OWARI');
  });

  it('does not catch BoA (real Japanese-resident KR-origin artist with a long JP career — explicitly NOT on the drop list)', () => {
    // BoA is omitted from the seed list per spec §2.E intent: the bias is
    // toward keeping entries, but acts that have shifted to a Japan-only
    // career are out of scope.
    check('BoA');
  });

  it('does not catch 中島美嘉 (kanji-script JP act)', () => {
    check('中島美嘉');
  });

  it('does not catch the empty string', () => {
    expect(isInDropList('')).toBe(false);
  });

  it('does not catch 椎名林檎 (sanity — pure JP)', () => {
    check('椎名林檎');
  });

  it('does not catch YOASOBI', () => {
    check('YOASOBI');
  });
});
