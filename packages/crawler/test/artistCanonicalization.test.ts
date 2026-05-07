import { describe, expect, it } from 'vitest';
import type { SongRecord } from '@karaoke/schema';
import {
  CANONICALIZATION_RULES,
  canonicalizeArtistName,
} from '../src/artistCanonicalization.js';
import { resolveArtistAliases } from '../src/aliases.js';

// ---------------------------------------------------------------------------
// canonicalizeArtistName — pure function unit tests
// ---------------------------------------------------------------------------

describe('canonicalizeArtistName — pure function', () => {
  it('returns name unchanged when no rule matches', () => {
    expect(canonicalizeArtistName('スピッツ')).toBe('スピッツ');
    expect(canonicalizeArtistName('BUMP OF CHICKEN')).toBe('BUMP OF CHICKEN');
    expect(canonicalizeArtistName('')).toBe('');
  });

  it('rewrites "Dreams Come True" → "DREAMS COME TRUE"', () => {
    expect(canonicalizeArtistName('Dreams Come True')).toBe('DREAMS COME TRUE');
  });

  it('rewrites "Bump of Chicken" → "BUMP OF CHICKEN"', () => {
    expect(canonicalizeArtistName('Bump of Chicken')).toBe('BUMP OF CHICKEN');
  });

  it('rewrites "LISA" → "LiSA"', () => {
    expect(canonicalizeArtistName('LISA')).toBe('LiSA');
  });

  it('rewrites "Unison Square Garden" → "UNISON SQUARE GARDEN"', () => {
    expect(canonicalizeArtistName('Unison Square Garden')).toBe('UNISON SQUARE GARDEN');
  });

  it('rewrites "BOA" → "BoA"', () => {
    expect(canonicalizeArtistName('BOA')).toBe('BoA');
  });

  it('rewrites "Judy and Mary" → "JUDY AND MARY"', () => {
    expect(canonicalizeArtistName('Judy and Mary')).toBe('JUDY AND MARY');
  });

  it('rewrites "Judy And Mary" → "JUDY AND MARY"', () => {
    expect(canonicalizeArtistName('Judy And Mary')).toBe('JUDY AND MARY');
  });

  it('rewrites "Kinki Kids" → "KinKi Kids"', () => {
    expect(canonicalizeArtistName('Kinki Kids')).toBe('KinKi Kids');
  });

  it('rewrites "Kinki kids" → "KinKi Kids"', () => {
    expect(canonicalizeArtistName('Kinki kids')).toBe('KinKi Kids');
  });

  it('rewrites "PEOPLE 1" → "People 1"', () => {
    expect(canonicalizeArtistName('PEOPLE 1')).toBe('People 1');
  });

  it('rewrites "Ano" → "ano"', () => {
    expect(canonicalizeArtistName('Ano')).toBe('ano');
  });

  it('rewrites "Chemistry" → "CHEMISTRY"', () => {
    expect(canonicalizeArtistName('Chemistry')).toBe('CHEMISTRY');
  });

  it('rewrites "Luna Sea" → "Luna sea"', () => {
    expect(canonicalizeArtistName('Luna Sea')).toBe('Luna sea');
  });

  it('rewrites ASCII-& "タッキー&翼" → full-width-& "タッキー＆翼"', () => {
    expect(canonicalizeArtistName('タッキー&翼')).toBe('タッキー＆翼');
  });

  it('rewrites "Lia" → "LIA" (alphabetical tiebreak on equal counts)', () => {
    expect(canonicalizeArtistName('Lia')).toBe('LIA');
  });

  it('rewrites "Hitomi" → "hitomi"', () => {
    expect(canonicalizeArtistName('Hitomi')).toBe('hitomi');
  });

  it('rewrites "TK from 凛として時雨" → "TK From 凛として時雨"', () => {
    expect(canonicalizeArtistName('TK from 凛として時雨')).toBe('TK From 凛として時雨');
  });

  it('rewrites "I WiSH" → "I WISH" (alphabetical tiebreak)', () => {
    expect(canonicalizeArtistName('I WiSH')).toBe('I WISH');
  });

  it('rewrites "4 In love" → "4 In Love" (alphabetical tiebreak)', () => {
    expect(canonicalizeArtistName('4 In love')).toBe('4 In Love');
  });

  it('rewrites "Mrs. Green Apple" → "Mrs. GREEN APPLE"', () => {
    expect(canonicalizeArtistName('Mrs. Green Apple')).toBe('Mrs. GREEN APPLE');
  });

  it('CANONICALIZATION_RULES has exactly 20 entries', () => {
    expect(CANONICALIZATION_RULES).toHaveLength(20);
  });

  it('all rules have non-empty from and to that differ', () => {
    for (const rule of CANONICALIZATION_RULES) {
      expect(rule.from.length).toBeGreaterThan(0);
      expect(rule.to.length).toBeGreaterThan(0);
      expect(rule.from).not.toBe(rule.to);
    }
  });

  it('all rules produce NFKC-equivalent from and to', () => {
    for (const rule of CANONICALIZATION_RULES) {
      expect(rule.from.normalize('NFKC').toLowerCase()).toBe(
        rule.to.normalize('NFKC').toLowerCase(),
      );
    }
  });

  it('no two rules share the same from value', () => {
    const froms = CANONICALIZATION_RULES.map((r) => r.from);
    const unique = new Set(froms);
    expect(unique.size).toBe(froms.length);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 integration via resolveArtistAliases
// ---------------------------------------------------------------------------

function record(over: Partial<SongRecord>): SongRecord {
  return {
    id: 'blog-1-0',
    source_url: 'https://example.test/1',
    title_primary: 'Some Song',
    title_ko: null,
    artist_primary: 'Some Artist',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    categories: ['jpop'],
    crawled_at: '2026-05-04T10:00:00Z',
    ...over,
  };
}

describe('resolveArtistAliases — Phase 4 canonicalization', () => {
  it('rewrites minority form and preserves original in artist_aliases', () => {
    const r = record({ id: 'tj-001', artist_primary: 'Bump of Chicken' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('BUMP OF CHICKEN');
    expect(records[0]?.artist_aliases).toContain('Bump of Chicken');
  });

  it('does not rewrite canonical form (no-op)', () => {
    const r = record({ id: 'tj-002', artist_primary: 'BUMP OF CHICKEN' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('BUMP OF CHICKEN');
    expect(records[0]?.artist_aliases).toBeUndefined();
  });

  it('does not rewrite pipe-form records (Phase 1 already handles them)', () => {
    const r = record({
      id: 'blog-003',
      artist_primary: 'Bump of Chicken｜バンプオブチキン',
    });
    const { records } = resolveArtistAliases([r]);
    // Phase 1 splits it — canonical becomes "Bump of Chicken", then Phase 4
    // rewrites "Bump of Chicken" → "BUMP OF CHICKEN" since it's now bare.
    // Wait — Phase 4 checks for FULLWIDTH_PIPE in artist_primary AFTER Phase 3.
    // After Phase 1, artist_primary = "Bump of Chicken" (no pipe), so Phase 4 fires.
    expect(records[0]?.artist_primary).toBe('BUMP OF CHICKEN');
    expect(records[0]?.artist_aliases).toContain('バンプオブチキン');
  });

  it('merges existing artist_aliases with original minority form', () => {
    const r = record({
      id: 'tj-004',
      artist_primary: 'LISA',
      artist_aliases: ['Lisa'],
    });
    const { records } = resolveArtistAliases([r]);
    expect(records[0]?.artist_primary).toBe('LiSA');
    const aliases = records[0]?.artist_aliases ?? [];
    expect(aliases).toContain('Lisa');
    expect(aliases).toContain('LISA');
    // canonical should not appear in aliases
    expect(aliases).not.toContain('LiSA');
  });

  it('is idempotent — second pass is a no-op', () => {
    const r = record({ id: 'tj-005', artist_primary: 'Dreams Come True' });
    const first = resolveArtistAliases([r]);
    const second = resolveArtistAliases(first.records);
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });

  it('rewrites ASCII-& タッキー variant correctly', () => {
    const r = record({ id: 'tj-006', artist_primary: 'タッキー&翼' });
    const { records } = resolveArtistAliases([r]);
    expect(records[0]?.artist_primary).toBe('タッキー＆翼');
    expect(records[0]?.artist_aliases).toContain('タッキー&翼');
  });

  it('Phase 4 does not fire when Phase 3 already re-keyed the record', () => {
    // Seed a pipe-form that creates alias "Spitz" → canonical "スピッツ".
    // A bare "Spitz" record goes through Phase 3 re-keying to "スピッツ".
    // "スピッツ" has no canonicalization rule — Phase 4 is a no-op.
    const seed = record({ id: 'blog-100-0', artist_primary: 'スピッツ｜Spitz' });
    const bare = record({ id: 'tj-200', artist_primary: 'Spitz' });
    const { records } = resolveArtistAliases([seed, bare]);
    const out = records.find((r) => r.id === 'tj-200');
    expect(out?.artist_primary).toBe('スピッツ');
  });

  it('rewrites two minority forms of JUDY AND MARY independently', () => {
    const r1 = record({ id: 'tj-010', artist_primary: 'Judy and Mary' });
    const r2 = record({ id: 'tj-011', artist_primary: 'Judy And Mary' });
    const { records } = resolveArtistAliases([r1, r2]);
    const out1 = records.find((r) => r.id === 'tj-010');
    const out2 = records.find((r) => r.id === 'tj-011');
    expect(out1?.artist_primary).toBe('JUDY AND MARY');
    expect(out1?.artist_aliases).toContain('Judy and Mary');
    expect(out2?.artist_primary).toBe('JUDY AND MARY');
    expect(out2?.artist_aliases).toContain('Judy And Mary');
  });
});
