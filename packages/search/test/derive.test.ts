import { describe, expect, it } from 'vitest';
import { deriveKanaRomaji } from '../src/index';

describe('deriveKanaRomaji', () => {
  it('romanizes a hiragana reading', () => {
    expect(deriveKanaRomaji('よるにかける')).toBe('yorunikakeru');
  });

  it('romanizes a katakana reading', () => {
    expect(deriveKanaRomaji('グレンゲ')).toBe('gurenge');
  });

  it('returns null for strings containing kanji (no kanji readings generated here)', () => {
    expect(deriveKanaRomaji('夜に駆ける')).toBeNull();
    expect(deriveKanaRomaji('千本桜')).toBeNull();
  });

  it('returns null for Latin/romaji input (nothing to derive)', () => {
    expect(deriveKanaRomaji('yoru')).toBeNull();
    expect(deriveKanaRomaji('Idol')).toBeNull();
  });

  it('returns null for blank or non-kana input', () => {
    expect(deriveKanaRomaji('')).toBeNull();
    expect(deriveKanaRomaji('   ')).toBeNull();
    expect(deriveKanaRomaji('사랑')).toBeNull();
  });
});
