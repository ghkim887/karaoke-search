import { describe, expect, it, vi } from 'vitest';
import {
  type BlogWhitelistRecord,
  buildBlogWhitelist,
  shouldAdmitArtistToWhitelist,
} from '../../../src/adapters/tj-media-direct/crawler.js';

describe('shouldAdmitArtistToWhitelist (PR-3 script-signal trim)', () => {
  it('skips Han-only artist (pure Chinese signal)', () => {
    expect(shouldAdmitArtistToWhitelist('王菲')).toBe(false);
  });

  it('skips Hangul-only artist (pure Korean signal)', () => {
    expect(shouldAdmitArtistToWhitelist('이수')).toBe(false);
  });

  it('admits Han + kana mixed artist (kana saves it)', () => {
    // モーニング娘 — モ/ー/ニ/ン/グ are katakana, 娘 is Han. The kana presence
    // is the JP signal; the trim only strips records that are pure Han or
    // pure Hangul. (A pure-kanji JP act like 東京事変 will be skipped at the
    // rescue path by design — they round-trip via path-1/path-2 anyway.)
    expect(shouldAdmitArtistToWhitelist('モーニング娘')).toBe(true);
  });

  it("admits pure Latin artist (could be a JP-Latin act like L'Arc~en~Ciel)", () => {
    expect(shouldAdmitArtistToWhitelist("L'Arc~en~Ciel")).toBe(true);
  });

  it('admits kana-only artist (genuine JP)', () => {
    expect(shouldAdmitArtistToWhitelist('ヨアソビ')).toBe(true);
  });

  it('admits mixed Hangul + kana edge case (kana saves it)', () => {
    expect(shouldAdmitArtistToWhitelist('에반스 & ヨネ')).toBe(true);
  });

  it('skips empty / null / undefined artist (no signal)', () => {
    expect(shouldAdmitArtistToWhitelist('')).toBe(false);
    expect(shouldAdmitArtistToWhitelist(null)).toBe(false);
    expect(shouldAdmitArtistToWhitelist(undefined)).toBe(false);
  });
});

describe('buildBlogWhitelist (PR-3 trim)', () => {
  function rec(artist: string | null, tj: string | null): BlogWhitelistRecord {
    return { artist_primary: artist, karaoke_numbers: { tj } };
  }

  it('admits genuine JP records and skips Han-only / Hangul-only entries', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const set = buildBlogWhitelist([
        rec('YOASOBI', '11111'),
        rec('王菲', '22222'),
        rec('이수', '33333'),
        rec('モーニング娘', '44444'),
        rec("L'Arc~en~Ciel", '55555'),
      ]);

      expect(set.has('11111')).toBe(true);
      expect(set.has('22222')).toBe(false);
      expect(set.has('33333')).toBe(false);
      expect(set.has('44444')).toBe(true);
      expect(set.has('55555')).toBe(true);
      expect(set.size).toBe(3);
    } finally {
      log.mockRestore();
    }
  });

  it('skips records with empty/null tj', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const set = buildBlogWhitelist([
        rec('YOASOBI', null),
        rec('YOASOBI', ''),
        rec('YOASOBI', '99999'),
      ]);
      expect(set.size).toBe(1);
      expect(set.has('99999')).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('logs a one-line summary of kept vs skipped counts', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      buildBlogWhitelist([rec('YOASOBI', '11111'), rec('王菲', '22222'), rec('이수', '33333')]);
      expect(log).toHaveBeenCalledTimes(1);
      const msg = log.mock.calls[0]?.[0] as string;
      expect(msg).toMatch(/kept 1 of 3 records/);
      expect(msg).toMatch(/skipped 2/);
    } finally {
      log.mockRestore();
    }
  });
});
