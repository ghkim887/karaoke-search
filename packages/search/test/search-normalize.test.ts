import { describe, expect, it } from 'vitest';
import {
  compactSearchText,
  makeCharacterNgrams,
  makeHangulInitials,
  normalizeKaraokeNumber,
  normalizeSearchText,
  parseKaraokeNumberQuery,
  tokenizeSearchWords,
} from '../src/index';

describe('search text normalization', () => {
  it('compacts Latin artist punctuation the same way as the web index', () => {
    expect(compactSearchText('DECO*27')).toBe('deco27');
    expect(compactSearchText('Mrs. GREEN APPLE')).toBe('mrsgreenapple');
    expect(compactSearchText("B'z")).toBe('bz');
  });

  it('normalizes Unicode width and case before tokenizing words', () => {
    expect(normalizeSearchText('ＡＢＣ １２３')).toBe('abc 123');
    expect(tokenizeSearchWords('Mrs. GREEN APPLE')).toEqual(['mrs', 'green', 'apple']);
  });

  it('keeps Japanese long vowel marks and exposes CJK character ngrams', () => {
    const compact = compactSearchText('残酷な天使のテーゼ');

    expect(makeCharacterNgrams(compact, 2)).toContain('天使');
    expect(makeCharacterNgrams(compact, 3)).toContain('天使の');
    expect(compactSearchText('テーゼ')).toBe('テーゼ');
    expect(compactSearchText('ﾃｰｾﾞ')).toBe('テーゼ');
  });

  it('does not fold hiragana and katakana without an explicit kana-reading source', () => {
    expect(compactSearchText('てーぜ')).toBe('てーぜ');
    expect(compactSearchText('てーぜ')).not.toBe(compactSearchText('テーゼ'));
  });

  it('generates Hangul syllable ngrams and choseong initials', () => {
    const compact = compactSearchText('사랑했나봐');

    expect(makeCharacterNgrams(compact, 2)).toContain('사랑');
    expect(makeHangulInitials('사랑했나봐')).toBe('ㅅㄹㅎㄴㅂ');
    expect(makeHangulInitials('ㅅㄹ')).toBe('ㅅㄹ');
    expect(makeHangulInitials('Bz 残酷')).toBe('');
  });
});

describe('karaoke number normalization', () => {
  it('normalizes numeric strings without stripping meaningful leading zeroes', () => {
    expect(normalizeKaraokeNumber(' ０６８-７４８ ')).toBe('068748');
  });

  it('parses provider-qualified karaoke number queries', () => {
    expect(parseKaraokeNumberQuery('TJ 068748')).toEqual({ provider: 'tj', number: '068748' });
    expect(parseKaraokeNumberQuery('tj68748')).toEqual({ provider: 'tj', number: '68748' });
    expect(parseKaraokeNumberQuery('KY-44888')).toEqual({ provider: 'ky', number: '44888' });
    expect(parseKaraokeNumberQuery('joysound 613446')).toEqual({
      provider: 'joysound',
      number: '613446',
    });
  });

  it('parses plain numeric queries and rejects unrelated text', () => {
    expect(parseKaraokeNumberQuery('68748')).toEqual({ number: '68748' });
    expect(parseKaraokeNumberQuery('RADWIMPS')).toBeNull();
    expect(parseKaraokeNumberQuery('TJ RADWIMPS')).toBeNull();
  });
});
