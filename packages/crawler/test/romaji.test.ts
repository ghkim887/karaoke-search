import { describe, expect, it } from 'vitest';
import { needsRomaji, toRomaji } from '../src/romaji.js';

describe('needsRomaji', () => {
  it('returns false for pure-Latin "Lemon"', () => {
    expect(needsRomaji('Lemon')).toBe(false);
  });

  it('returns false for pure-Latin "NIGHT DANCER"', () => {
    expect(needsRomaji('NIGHT DANCER')).toBe(false);
  });

  it('returns false for fullwidth-Latin "Ｉｄｏｌ" (NFKC strips fullwidth)', () => {
    expect(needsRomaji('Ｉｄｏｌ')).toBe(false);
  });

  it('returns true for mixed-script "花に亡霊 (movie ver.)"', () => {
    expect(needsRomaji('花に亡霊 (movie ver.)')).toBe(true);
  });

  it('returns true for pure-hiragana "あぶく"', () => {
    expect(needsRomaji('あぶく')).toBe(true);
  });
});

describe('toRomaji', () => {
  it('produces Hepburn romaji for hiragana "あぶく"', () => {
    expect(toRomaji('あぶく')).toBe('abuku');
  });
});
