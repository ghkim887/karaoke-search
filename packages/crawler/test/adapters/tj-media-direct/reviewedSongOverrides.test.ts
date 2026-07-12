import { describe, expect, it } from 'vitest';
import {
  REVIEWED_TJ_SONG_ALLOW_LIST,
  REVIEWED_TJ_SONG_DROP_LIST,
  isReviewedTjSongAllow,
  isReviewedTjSongDrop,
  reviewedTjSongRender,
} from '../../../src/adapters/tj-media-direct/reviewedSongOverrides.js';

describe('reviewedSongOverrides — 2026-06 FP/FN audit lists', () => {
  it('carries exactly 113 allow entries and 10 drop entries (audit counts)', () => {
    // Accidental dedup/loss of a single entry silently changes which songs
    // are admitted/dropped — pin the audited counts.
    expect(REVIEWED_TJ_SONG_ALLOW_LIST.length).toBe(113);
    expect(REVIEWED_TJ_SONG_DROP_LIST.length).toBe(10);
  });

  it('has no duplicate TJ numbers within or across the two lists', () => {
    const allowTjs = REVIEWED_TJ_SONG_ALLOW_LIST.map((entry) => entry.tj);
    const dropTjs = REVIEWED_TJ_SONG_DROP_LIST.map((entry) => entry.tj);
    const all = [...allowTjs, ...dropTjs];
    expect(new Set(all).size).toBe(all.length);
  });

  it('every entry has a normalized TJ number and non-empty title/artist/decidedOn metadata', () => {
    for (const entry of [...REVIEWED_TJ_SONG_ALLOW_LIST, ...REVIEWED_TJ_SONG_DROP_LIST]) {
      // TJ key must already be in the normalized shape the lookup Sets use
      // (digits only, no leading zeros) — otherwise the entry can never match.
      expect(entry.tj).toMatch(/^[1-9]\d*$/);
      // Provenance metadata: a bare number is unauditable. The 2026-06
      // backfill recovered title/artist for all 121 entries — placeholders
      // are not acceptable for new entries either (audit before adding).
      expect(entry.title.trim()).not.toBe('');
      expect(entry.artist.trim()).not.toBe('');
      expect(entry.title).not.toBe('(unrecovered)');
      expect(entry.artist).not.toBe('(unrecovered)');
      // Decision month only (`YYYY-MM`, UTC) — matches the interface doc.
      expect(entry.decidedOn).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it('isReviewedTjSongAllow matches list entries with leading-zero normalization', () => {
    for (const entry of REVIEWED_TJ_SONG_ALLOW_LIST) {
      expect(isReviewedTjSongAllow(entry.tj)).toBe(true);
      expect(isReviewedTjSongAllow(`00${entry.tj}`)).toBe(true);
      expect(isReviewedTjSongAllow(` ${entry.tj} `)).toBe(true);
      expect(isReviewedTjSongDrop(entry.tj)).toBe(false);
    }
  });

  it('isReviewedTjSongDrop matches list entries with leading-zero normalization', () => {
    for (const entry of REVIEWED_TJ_SONG_DROP_LIST) {
      expect(isReviewedTjSongDrop(entry.tj)).toBe(true);
      expect(isReviewedTjSongDrop(`00${entry.tj}`)).toBe(true);
      expect(isReviewedTjSongDrop(` ${entry.tj} `)).toBe(true);
      expect(isReviewedTjSongAllow(entry.tj)).toBe(false);
    }
  });

  it('rejects non-member and degenerate inputs', () => {
    for (const input of ['', '   ', '0', '000', '999999', 'abc']) {
      expect(isReviewedTjSongAllow(input)).toBe(false);
      expect(isReviewedTjSongDrop(input)).toBe(false);
    }
  });

  it('pins sentinel members so a wholesale content swap cannot pass on counts alone', () => {
    // 27069 = Tell Me Goodbye (Big Bang), hand-audited ALLOW from the 2026-06 audit.
    expect(isReviewedTjSongAllow('27069')).toBe(true);
    // 7055 = Besame Mucho (Various Artists), hand-audited DROP (generic non-scope row).
    expect(isReviewedTjSongDrop('7055')).toBe(true);
    // 70438 = 프리큐큐 / CUTIE STREET, the 2026-07-11 leak-gate per-song DROP
    // (Korean-language row by a Japanese act). Pins it on the drop list.
    expect(isReviewedTjSongDrop('70438')).toBe(true);
    expect(isReviewedTjSongAllow('70438')).toBe(false);
    // A plausible TJ number that was never audited must hit neither list.
    expect(isReviewedTjSongAllow('12345')).toBe(false);
    expect(isReviewedTjSongDrop('12345')).toBe(false);
  });
});

describe('reviewedSongOverrides — per-song render overrides', () => {
  it('stamps the leak-gate-safe display form for tj 68976 (IVE "Will")', () => {
    // The catalog artist "IVE(아이브)" carries a Hangul gloss that trips the
    // product-corpus leak gate even though the row is an allow-listed JP
    // release. `render` supplies the script-clean display form.
    expect(reviewedTjSongRender('68976')).toEqual({ artist_primary: 'IVE', artist_ko: '아이브' });
    // Leading-zero / whitespace normalization matches the lookup Sets.
    expect(reviewedTjSongRender('0068976')).toEqual({ artist_primary: 'IVE', artist_ko: '아이브' });
    // The stamped primary must be Hangul-free (the invariant the leak gate needs).
    expect(reviewedTjSongRender('68976')?.artist_primary).not.toMatch(/[가-힣]/);
  });

  it('returns undefined for rows without a render override (raw indexSong is kept)', () => {
    // tj 52990 (BOYNEXTDOOR) is allow-listed but the TJ raw is already Latin-only,
    // so it carries no render — the precedent that motivates the per-song seam.
    expect(reviewedTjSongRender('52990')).toBeUndefined();
    // Drop-listed and non-member TJ numbers likewise have no render.
    expect(reviewedTjSongRender('70438')).toBeUndefined();
    expect(reviewedTjSongRender('12345')).toBeUndefined();
  });

  it('every render override yields a Hangul-free artist_primary (leak-gate invariant)', () => {
    for (const entry of REVIEWED_TJ_SONG_ALLOW_LIST) {
      if (!entry.render) continue;
      expect(entry.render.artist_primary.trim()).not.toBe('');
      expect(entry.render.artist_primary).not.toMatch(/[가-힣]/);
    }
  });
});
