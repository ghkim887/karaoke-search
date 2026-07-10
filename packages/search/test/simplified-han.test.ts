import { describe, expect, it } from 'vitest';
import { SIMPLIFIED_ONLY_HAN, hasSimplifiedOnlyHan } from '../src/index';

// The whole point of this predicate is precision against the shinjitai trap:
// many PRC simplifications equal the Japanese shinjitai (国 学 体 会 医 数 …) and
// those are valid Japanese — they MUST NOT match. These tests pin both that the
// curated set fires on genuine simplified-Chinese text AND that it stays silent
// on shinjitai-heavy Japanese, traditional Chinese, and kana-mixed titles.

describe('hasSimplifiedOnlyHan — positive (genuine simplified Chinese)', () => {
  it('matches the standalone simplified love glyph 爱', () => {
    expect(hasSimplifiedOnlyHan('爱')).toBe(true);
  });

  it('matches the catalog-anomaly Mandopop title 明天你是否依然爱我 (via 爱)', () => {
    expect(hasSimplifiedOnlyHan('明天你是否依然爱我')).toBe(true);
  });

  it('matches a Mandarin pronoun/function word (我们 via 们, 这是 via 这)', () => {
    expect(hasSimplifiedOnlyHan('我们')).toBe(true);
    expect(hasSimplifiedOnlyHan('这是我的歌')).toBe(true);
  });

  it('matches a 讠 speech-radical simplification (说谎 via 说)', () => {
    expect(hasSimplifiedOnlyHan('说谎')).toBe(true);
  });

  it('matches simplified Chinese artist names (刘德华, 邓丽君, 张学友)', () => {
    expect(hasSimplifiedOnlyHan('刘德华')).toBe(true); // 刘 + 华
    expect(hasSimplifiedOnlyHan('邓丽君')).toBe(true); // 邓
    expect(hasSimplifiedOnlyHan('张学友')).toBe(true); // 张 (学 is excluded shinjitai)
  });

  it('matches a simplified char anywhere in a longer mixed string', () => {
    expect(hasSimplifiedOnlyHan('Live 现场 龙的传人')).toBe(true); // 龙
  });
});

describe('hasSimplifiedOnlyHan — negative (shinjitai-heavy Japanese)', () => {
  it('does NOT match Japanese titles built from shared shinjitai', () => {
    // Every kanji here is a valid Japanese form; several (国 学 体 会 医 数) are
    // exactly the shinjitai==PRC-simplified trap the set must exclude.
    expect(hasSimplifiedOnlyHan('国家')).toBe(false);
    expect(hasSimplifiedOnlyHan('学校')).toBe(false);
    expect(hasSimplifiedOnlyHan('体育')).toBe(false);
    expect(hasSimplifiedOnlyHan('医学と数学')).toBe(false);
    expect(hasSimplifiedOnlyHan('万葉集')).toBe(false);
  });

  it('does NOT match a real kanji Japanese song title', () => {
    expect(hasSimplifiedOnlyHan('残酷な天使のテーゼ')).toBe(false);
    expect(hasSimplifiedOnlyHan('夜に駆ける')).toBe(false);
    expect(hasSimplifiedOnlyHan('千本桜')).toBe(false);
  });

  it('does NOT match the Japanese counterpart glyphs of set members', () => {
    // Japanese uses 関/會→会/議/話, never the PRC 关/议/话.
    expect(hasSimplifiedOnlyHan('関係')).toBe(false); // 関, not 关
    expect(hasSimplifiedOnlyHan('会議')).toBe(false); // 議 (U+8B70), not 议
  });
});

describe('hasSimplifiedOnlyHan — negative (traditional Chinese & kana)', () => {
  it('does NOT match TRADITIONAL Chinese forms (Japanese uses these too)', () => {
    expect(hasSimplifiedOnlyHan('愛')).toBe(false); // traditional/JA love, not 爱
    expect(hasSimplifiedOnlyHan('龍')).toBe(false); // traditional dragon, not 龙
    expect(hasSimplifiedOnlyHan('說話')).toBe(false); // traditional 說 話, not 说 话
    expect(hasSimplifiedOnlyHan('劉德華')).toBe(false); // traditional Andy Lau, not 刘 华
  });

  it('does NOT match pure kana or kana-mixed input', () => {
    expect(hasSimplifiedOnlyHan('よるにかける')).toBe(false);
    expect(hasSimplifiedOnlyHan('アイドル')).toBe(false);
  });

  it('returns false for empty / punctuation-only input', () => {
    expect(hasSimplifiedOnlyHan('')).toBe(false);
    expect(hasSimplifiedOnlyHan('!?()-')).toBe(false);
  });
});

describe('SIMPLIFIED_ONLY_HAN — curated set membership', () => {
  it('includes a reviewable few-dozen characters (not an exhaustive dump)', () => {
    expect(SIMPLIFIED_ONLY_HAN.size).toBeGreaterThan(40);
    expect(SIMPLIFIED_ONLY_HAN.size).toBeLessThan(120);
  });

  it('contains high-signal PRC-only simplifications', () => {
    for (const ch of ['爱', '们', '这', '说', '刘', '张', '龙', '门']) {
      expect(SIMPLIFIED_ONLY_HAN.has(ch)).toBe(true);
    }
  });

  it('EXCLUDES shinjitai that equal PRC simplifications (the trap)', () => {
    // These are valid Japanese kanji and would false-positive on Japanese songs.
    for (const ch of ['国', '学', '体', '会', '医', '数', '万', '与', '声']) {
      expect(SIMPLIFIED_ONLY_HAN.has(ch)).toBe(false);
    }
  });

  it('EXCLUDES traditional forms (which appear in Japanese text)', () => {
    for (const ch of ['愛', '龍', '說', '話', '關', '劉']) {
      expect(SIMPLIFIED_ONLY_HAN.has(ch)).toBe(false);
    }
  });
});
