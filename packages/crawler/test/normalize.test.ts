import { describe, expect, it } from 'vitest';
import { normalize } from '../src/normalize.js';

// Worked examples lifted directly from the spec Data Model section.
describe('normalize', () => {
  it('strips ASCII punctuation including the asterisk in DECO*27', () => {
    expect(normalize('DECO*27')).toBe('deco27');
  });

  it('leaves katakana unchanged after NFKC and casefold', () => {
    expect(normalize('ヨルシカ')).toBe('ヨルシカ');
  });

  it('leaves CJK ideographs unchanged', () => {
    expect(normalize('米津玄師')).toBe('米津玄師');
  });

  it('casefolds all-caps Latin', () => {
    expect(normalize('YOASOBI')).toBe('yoasobi');
  });

  it('passes already-lowercase Latin through unchanged', () => {
    expect(normalize('imase')).toBe('imase');
  });

  it('strips spaces and ASCII punctuation from a mixed-script title', () => {
    expect(normalize('花に亡霊 (movie ver.)')).toBe('花に亡霊moviever');
  });

  it('strips dots and spaces from "Mrs. GREEN APPLE"', () => {
    expect(normalize('Mrs. GREEN APPLE')).toBe('mrsgreenapple');
  });

  it('NFKC-normalizes fullwidth Latin to ASCII before casefold', () => {
    expect(normalize('Ｉｄｏｌ')).toBe('idol');
  });
});
