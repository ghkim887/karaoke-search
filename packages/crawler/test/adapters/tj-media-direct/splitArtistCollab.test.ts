import { describe, expect, it } from 'vitest';
import {
  getLeadComponent,
  normalizeForMatch,
  splitArtistCollab,
} from '../../../src/adapters/tj-media-direct/normalize.js';

/**
 * `splitArtistCollab` is the PR-4 multi-artist splitter — it explodes
 * collab strings (`imase & なとり`, `Charlie Puth(Feat.宇多田ヒカル)`, …)
 * into component names so the per-artist scan can tag each component
 * independently. The whole string is always the FIRST element of the
 * returned array so single-artist names round-trip unchanged AND the
 * existing per-record cache path keeps hitting on the whole-string key.
 */
describe('splitArtistCollab — single-artist (round-trip)', () => {
  it('returns [whole] for a Latin single artist', () => {
    expect(splitArtistCollab('YOASOBI')).toEqual(['YOASOBI']);
  });

  it('returns [whole] for a kana single artist', () => {
    expect(splitArtistCollab('ヨルシカ')).toEqual(['ヨルシカ']);
  });

  it('trims surrounding whitespace before returning', () => {
    expect(splitArtistCollab('   YOASOBI   ')).toEqual(['YOASOBI']);
  });

  it('returns [] for an empty string', () => {
    expect(splitArtistCollab('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(splitArtistCollab('   ')).toEqual([]);
  });

  it('does NOT split on slashes (Artist1/Artist2 stays whole — covers AC/DC)', () => {
    expect(splitArtistCollab('AC/DC')).toEqual(['AC/DC']);
  });
});

describe('splitArtistCollab — ampersand collabs', () => {
  it('splits `imase & なとり` into whole + 2 components', () => {
    expect(splitArtistCollab('imase & なとり')).toEqual(['imase & なとり', 'imase', 'なとり']);
  });

  it('splits an all-Latin ampersand collab', () => {
    expect(splitArtistCollab('MY FIRST STORY & HYDE')).toEqual([
      'MY FIRST STORY & HYDE',
      'MY FIRST STORY',
      'HYDE',
    ]);
  });

  it('handles a tight (no-space) ampersand `A&B`', () => {
    expect(splitArtistCollab('A&B')).toEqual(['A&B', 'A', 'B']);
  });
});

describe('splitArtistCollab — comma collabs', () => {
  it('splits a 3-way comma collab `IDOLiSH7,TRIGGER,Re:vale`', () => {
    expect(splitArtistCollab('IDOLiSH7,TRIGGER,Re:vale')).toEqual([
      'IDOLiSH7,TRIGGER,Re:vale',
      'IDOLiSH7',
      'TRIGGER',
      'Re:vale',
    ]);
  });

  it('handles comma + space `A, B`', () => {
    expect(splitArtistCollab('A, B')).toEqual(['A, B', 'A', 'B']);
  });
});

describe('splitArtistCollab — feat. parenthetical collabs', () => {
  it('splits `Charlie Puth(Feat.宇多田ヒカル)` (no space before paren)', () => {
    expect(splitArtistCollab('Charlie Puth(Feat.宇多田ヒカル)')).toEqual([
      'Charlie Puth(Feat.宇多田ヒカル)',
      'Charlie Puth',
      '宇多田ヒカル',
    ]);
  });

  it('splits `Artist1 (feat. Artist2)` (lowercase + space)', () => {
    expect(splitArtistCollab('Artist1 (feat. Artist2)')).toEqual([
      'Artist1 (feat. Artist2)',
      'Artist1',
      'Artist2',
    ]);
  });

  it('splits an un-parenthesized `Artist1 feat. Artist2`', () => {
    expect(splitArtistCollab('Artist1 feat. Artist2')).toEqual([
      'Artist1 feat. Artist2',
      'Artist1',
      'Artist2',
    ]);
  });

  // Fix 1: mid-string (Feat. X) parenthetical followed by primary delimiter
  it('splits `Charlie Puth(Feat.宇多田ヒカル) & Adele` — paren not at end-of-string', () => {
    expect(splitArtistCollab('Charlie Puth(Feat.宇多田ヒカル) & Adele')).toEqual([
      'Charlie Puth(Feat.宇多田ヒカル) & Adele',
      'Charlie Puth',
      'Adele',
      '宇多田ヒカル',
    ]);
  });

  it('splits `A (Feat. B) & C` — mid-string spaced parens', () => {
    expect(splitArtistCollab('A (Feat. B) & C')).toEqual(['A (Feat. B) & C', 'A', 'C', 'B']);
  });

  // Fix 3: all-caps FEAT. in parenthetical
  it('splits `Charlie Puth (FEAT. 宇多田ヒカル)` — all-caps FEAT.', () => {
    expect(splitArtistCollab('Charlie Puth (FEAT. 宇多田ヒカル)')).toEqual([
      'Charlie Puth (FEAT. 宇多田ヒカル)',
      'Charlie Puth',
      '宇多田ヒカル',
    ]);
  });
});

describe('splitArtistCollab — `(Prod. X)` producer-credit collabs (post-Phase-2 Gap 2)', () => {
  it('splits `LE SSERAFIM(Prod.imase)` — Korean lead with JP producer', () => {
    expect(splitArtistCollab('LE SSERAFIM(Prod.imase)')).toEqual([
      'LE SSERAFIM(Prod.imase)',
      'LE SSERAFIM',
      'imase',
    ]);
  });

  it('splits `LE SSERAFIM(Prod.Gen Hoshino)` — multi-token producer name', () => {
    expect(splitArtistCollab('LE SSERAFIM(Prod.Gen Hoshino)')).toEqual([
      'LE SSERAFIM(Prod.Gen Hoshino)',
      'LE SSERAFIM',
      'Gen Hoshino',
    ]);
  });

  it('splits all-caps `(PROD.X)` (case-insensitive)', () => {
    expect(splitArtistCollab('Artist1(PROD.Artist2)')).toEqual([
      'Artist1(PROD.Artist2)',
      'Artist1',
      'Artist2',
    ]);
  });
});

describe('splitArtistCollab — `X of Y` member-of-group sub-split (post-Phase-2 Gap 2)', () => {
  // Fix 1 (2026-05-01): the ` of ` sub-split is SCOPED to feat/prod parenthetical
  // content. Bare-string ` of ` (outside any feat/prod paren) does NOT trigger
  // sub-split. This avoids mangling legitimate names like `Bump of Chicken`,
  // `Out of the Blue`, etc.
  it('splits `MAX(Feat.Huh Yunjin of LE SSERAFIM)` into MAX + Huh Yunjin + LE SSERAFIM (positive regression)', () => {
    expect(splitArtistCollab('MAX(Feat.Huh Yunjin of LE SSERAFIM)')).toEqual([
      'MAX(Feat.Huh Yunjin of LE SSERAFIM)',
      'MAX',
      'Huh Yunjin of LE SSERAFIM',
      'Huh Yunjin',
      'LE SSERAFIM',
    ]);
  });

  it('splits `MAX(Feat.SUGA of BTS)` into MAX + SUGA + BTS (positive regression)', () => {
    expect(splitArtistCollab('MAX(Feat.SUGA of BTS)')).toEqual([
      'MAX(Feat.SUGA of BTS)',
      'MAX',
      'SUGA of BTS',
      'SUGA',
      'BTS',
    ]);
  });

  it('does NOT split when `of` lacks whitespace boundaries (e.g. `Profession`)', () => {
    expect(splitArtistCollab('Profession')).toEqual(['Profession']);
  });

  // Fix 1 negative cases — bare ` of ` outside feat/prod parens must NOT split.
  it('does NOT split `Bump of Chicken` (real Japanese rock band — Fix 1)', () => {
    expect(splitArtistCollab('Bump of Chicken')).toEqual(['Bump of Chicken']);
  });

  it('does NOT split `BUMP OF CHICKEN` (all-caps form — Fix 1)', () => {
    expect(splitArtistCollab('BUMP OF CHICKEN')).toEqual(['BUMP OF CHICKEN']);
  });

  it('does NOT split `Out of the Blue` (bare-string ` of ` — Fix 1)', () => {
    expect(splitArtistCollab('Out of the Blue')).toEqual(['Out of the Blue']);
  });

  it('does NOT split bare `SUGA of BTS` (no feat/prod scope — Fix 1)', () => {
    // Pre-Fix-1 this would have split on bare ` of `. The bare-string `of`
    // sub-split was a footgun (mangled `Bump of Chicken` etc.); the parser's
    // drop-list `SUGA of BTS` variant catches the real case directly via
    // normalized substring without needing a sub-split.
    expect(splitArtistCollab('SUGA of BTS')).toEqual(['SUGA of BTS']);
  });
});

describe('splitArtistCollab — full-width ampersand collabs (Fix 2)', () => {
  it('splits `imase ＆ なとり` on full-width ＆ (U+FF06)', () => {
    expect(splitArtistCollab('imase ＆ なとり')).toEqual(['imase ＆ なとり', 'imase', 'なとり']);
  });
});

describe('splitArtistCollab — all-caps FEAT. unparenthesized (Fix 3)', () => {
  it('splits `A FEAT. B` — all-caps unparenthesized', () => {
    expect(splitArtistCollab('A FEAT. B')).toEqual(['A FEAT. B', 'A', 'B']);
  });
});

describe('splitArtistCollab — `with` collabs', () => {
  it('splits `安室奈美恵 with スーパーモンキーズ`', () => {
    expect(splitArtistCollab('安室奈美恵 with スーパーモンキーズ')).toEqual([
      '安室奈美恵 with スーパーモンキーズ',
      '安室奈美恵',
      'スーパーモンキーズ',
    ]);
  });

  it('does NOT split when `with` is fused into another word (no whitespace boundary)', () => {
    expect(splitArtistCollab('Withers')).toEqual(['Withers']);
  });
});

describe('splitArtistCollab — multiplication-sign collabs', () => {
  it('splits `Artist X × Y` on the multiplication sign', () => {
    expect(splitArtistCollab('Artist X × Y')).toEqual(['Artist X × Y', 'Artist X', 'Y']);
  });
});

describe('splitArtistCollab — dedupe + edge cases', () => {
  it('dedupes via normalizeForMatch (case + whitespace) so `imase & IMASE` collapses', () => {
    const out = splitArtistCollab('imase & IMASE');
    // Whole string is preserved as parts[0]; both casings normalize to the
    // same key as the whole's component, so only one component slot remains.
    expect(out).toEqual(['imase & IMASE', 'imase']);
    // Sanity check that the dedupe key really is normalizeForMatch.
    const keys = new Set(out.map(normalizeForMatch));
    expect(keys.size).toBe(out.length);
  });

  it('skips empty parts produced by dangling delimiters (`A & `)', () => {
    expect(splitArtistCollab('A & ')).toEqual(['A &', 'A']);
  });

  it('does NOT split bracket-style `Artist1[ft.Artist2]` (out of scope)', () => {
    expect(splitArtistCollab('Artist1[ft.Artist2]')).toEqual(['Artist1[ft.Artist2]']);
  });
});

describe('splitArtistCollab — invariant lock (Fix A.3)', () => {
  // The internal contract is: when the function returns a non-empty array,
  // `out[0]` MUST equal the trimmed input. Multiple consumers (parser admit
  // rule, merger Tier C clustering) depend on this. The runtime assertion
  // throws if a future refactor breaks it; these tests exercise the assertion
  // implicitly by verifying the contract on a representative slice of inputs.
  it('parts[0] is always the trimmed whole-string', () => {
    const inputs = [
      'YOASOBI',
      'imase & なとり',
      'Charlie Puth(Feat.宇多田ヒカル)',
      '安室奈美恵 with スーパーモンキーズ',
      'imase ＆ なとり',
      'Artist X × Y',
      '   YOASOBI   ',
      'IDOLiSH7,TRIGGER,Re:vale',
    ];
    for (const inp of inputs) {
      const out = splitArtistCollab(inp);
      if (out.length > 0) expect(out[0]).toBe(inp.trim());
    }
  });
});

describe('getLeadComponent — Fix A.2 unified lead extractor', () => {
  // Parity test: the new shared `getLeadComponent` helper must produce the
  // same output for every Tier C test case the previous inline
  // `primaryArtistToken` regex produced. The old regex (frozen here as a
  // private constant for assertion-only) was:
  //   /\([Ff]eat\.|\([Pp]rod\.|｜|\s+&\s+|,\s|\s+with\s+|\s+[Ff]eat\.\s+/
  //
  // Cases include the four Tier C canonical inputs plus 4 inputs that
  // exercise delimiters present in `splitArtistCollab` but absent from the
  // old regex (`×`, `＆`, comma-no-space, all-caps `FEAT.`). The latter were
  // the silent-drift surface — the merger's clustering would have classified
  // those differently from the parser's admit rule.
  function legacyPrimaryArtistToken(artist: string): string {
    if (!artist) return '';
    const splitRe = /\([Ff]eat\.|\([Pp]rod\.|｜|\s+&\s+|,\s|\s+with\s+|\s+[Ff]eat\.\s+/;
    const m = splitRe.exec(artist);
    const lead = m ? artist.slice(0, m.index) : artist;
    return normalizeForMatch(lead.trim());
  }

  it('reproduces legacy primaryArtistToken output for the Tier C canonical inputs', () => {
    const tierCInputs = [
      '椎名もた(Feat.鏡音リン)',
      '椎名もた｜ぽわぽわP',
      'ナユタン星人',
      'ナユタン星人(Feat.初音ミク)',
      'MAX(Feat.SUGA of BTS)',
      'キタニタツヤ(Feat.はるまきごはん)',
      'キタニタツヤ',
      'キタニタツヤ & はるまきごはん',
      'imase(Prod.someone)',
      'imase',
      'X with Y',
      'X',
      'A, B',
      'A',
      'SoloOne',
      'SoloTwo',
      'YOASOBI',
    ];
    for (const inp of tierCInputs) {
      expect(getLeadComponent(inp)).toBe(legacyPrimaryArtistToken(inp));
    }
  });

  it('handles empty/whitespace inputs predictably', () => {
    expect(getLeadComponent('')).toBe('');
    expect(getLeadComponent('   ')).toBe('');
  });

  it('extends coverage to delimiters absent from the legacy regex (`×`, `＆`, comma-no-space, all-caps FEAT.)', () => {
    // These four are the silent-drift surface that motivated Fix A.2: the
    // legacy `primaryArtistToken` did NOT split on `×` or `＆` (full-width
    // ampersand), comma-without-space, or all-caps `FEAT.`. The new helper
    // does, matching the parser's admit-rule split exactly.
    expect(getLeadComponent('Artist1 × Artist2')).toBe(normalizeForMatch('Artist1'));
    expect(getLeadComponent('imase ＆ なとり')).toBe(normalizeForMatch('imase'));
    expect(getLeadComponent('A,B')).toBe(normalizeForMatch('A'));
    expect(getLeadComponent('A FEAT. B')).toBe(normalizeForMatch('A'));
  });
});
