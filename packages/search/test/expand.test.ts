import { describe, expect, it } from 'vitest';
import { expandSearchQuery, normalizeSearchText } from '../src/index';

describe('expandSearchQuery', () => {
  it('preserves the original query as the first variant', () => {
    expect(expandSearchQuery('yoru')[0]).toBe('yoru');
    expect(expandSearchQuery('よる')[0]).toBe('よる');
    expect(expandSearchQuery('天使')[0]).toBe('天使');
  });

  it('expands a Latin romaji query to hiragana and katakana variants', () => {
    const variants = expandSearchQuery('yoru');
    expect(variants).toContain('よる');
    expect(variants).toContain('ヨル');
  });

  it('expands a multi-mora romaji query to its kana spelling', () => {
    expect(expandSearchQuery('gurenge')).toContain('ぐれんげ');
    expect(expandSearchQuery('gurenge')).toContain('グレンゲ');
  });

  it('expands a kana query to a romaji variant', () => {
    expect(expandSearchQuery('よる')).toContain('yoru');
    expect(expandSearchQuery('ぐれんげ')).toContain('gurenge');
  });

  it('does not generate readings for queries containing kanji', () => {
    // Mixed kanji+kana titles must not be transliterated (no kanji readings).
    expect(expandSearchQuery('残酷な天使のテーゼ')).toEqual(['残酷な天使のテーゼ']);
    expect(expandSearchQuery('天使')).toEqual(['天使']);
  });

  it('treats supplementary-plane Han ideographs as kanji and returns them unchanged', () => {
    // 𠮟 is U+20B9F (CJK Ext B, supplementary plane). A mixed 𠮟 + kana query
    // must not expand to a romanized variant such as '𠮟ru'.
    expect(expandSearchQuery('𠮟る')).toEqual(['𠮟る']);
    expect(expandSearchQuery('𠮟')).toEqual(['𠮟']);
  });

  it('does not expand Hangul queries', () => {
    expect(expandSearchQuery('사랑')).toEqual(['사랑']);
    expect(expandSearchQuery('사랑했나봐')).toEqual(['사랑했나봐']);
  });

  it('returns an empty list for blank input', () => {
    expect(expandSearchQuery('')).toEqual([]);
    expect(expandSearchQuery('   ')).toEqual([]);
  });

  it('deduplicates normalized-equivalent variants and stays bounded', () => {
    const variants = expandSearchQuery('yoru');
    const normalized = variants.map((variant) => normalizeSearchText(variant));
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(variants.length).toBeLessThanOrEqual(3);
    expect(expandSearchQuery('よる').length).toBeLessThanOrEqual(3);
  });

  it('never throws on an over-long query and returns the no-expansion result', () => {
    // wanakana parses by per-token recursion and overflows the stack near ~5-6k
    // ASCII chars; a length guard must return the original unchanged instead.
    const longRomaji = 'ka'.repeat(3000); // 6000 code points
    expect(() => expandSearchQuery(longRomaji)).not.toThrow();
    expect(expandSearchQuery(longRomaji)).toEqual([longRomaji]);

    const longAscii = 'a'.repeat(6000);
    expect(() => expandSearchQuery(longAscii)).not.toThrow();
    expect(expandSearchQuery(longAscii)).toEqual([longAscii]);
  });

  it('applies the guard only above the code-point bound', () => {
    // At the 256 code-point bound a romaji query still expands normally.
    const atBound = 'ka'.repeat(128); // 256 code points
    expect([...atBound].length).toBe(256);
    expect(expandSearchQuery(atBound).length).toBeGreaterThan(1);
    // One code point over the bound: returned unchanged, no expansion.
    const overBound = `${atBound}k`; // 257 code points
    expect(expandSearchQuery(overBound)).toEqual([overBound]);
  });
});
