import type { SongRecord } from '@karaoke/schema';
import { describe, expect, it } from 'vitest';
import { resolveArtistAliases } from '../src/aliases.js';

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

describe('resolveArtistAliases — Phase 1 pipe-form splitter', () => {
  it('splits "ずっと真夜中でいいのに。｜ZUTOMAYO" into canonical + alias', () => {
    const r = record({
      id: 'blog-1-0',
      artist_primary: 'ずっと真夜中でいいのに。｜ZUTOMAYO',
    });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('ずっと真夜中でいいのに。');
    expect(records[0]?.artist_aliases).toEqual(['ZUTOMAYO']);
  });

  it('splits "40mP｜40meterP｜M40" into canonical + 2 aliases', () => {
    const r = record({ artist_primary: '40mP｜40meterP｜M40' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('40mP');
    expect(records[0]?.artist_aliases).toEqual(['40meterP', 'M40']);
  });

  it('treats trailing-empty pipe "Spitz｜" as canonical-only (no aliases, field omitted)', () => {
    const r = record({ artist_primary: 'Spitz｜' });
    const { records, warnings } = resolveArtistAliases([r]);
    // Spec §3.E: trailing empty seg yields canonical = "Spitz", no aliases.
    // Phase 1 sees `splitOnPipe` return ["Spitz"] (length 1) → malformed
    // branch fires (warning + record untouched). The spec table line 167
    // explicitly contemplates this as "canonical = Spitz, no aliases" but
    // also calls it malformed at line 166 (leading empty seg). Implementation
    // chooses the conservative reading: any pipe-present input that yields
    // < 2 non-empty segments is malformed.
    expect(warnings).toHaveLength(1);
    expect(records[0]?.artist_primary).toBe('Spitz｜');
    expect(records[0]?.artist_aliases).toBeUndefined();
  });

  it('emits a warning for malformed leading-empty pipe "｜Spitz" and leaves record untouched', () => {
    const r = record({ artist_primary: '｜Spitz' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(1);
    expect(records[0]?.artist_primary).toBe('｜Spitz');
    expect(records[0]?.artist_aliases).toBeUndefined();
  });

  it('preserves ASCII-pipe band name "Qverktett:||" untouched (no full-width pipe present)', () => {
    const r = record({ artist_primary: 'Qverktett:||' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('Qverktett:||');
    expect(records[0]?.artist_aliases).toBeUndefined();
  });

  it('NFKC-trims whitespace inside segments "  X  ｜  Y  "', () => {
    const r = record({ artist_primary: '  X  ｜  Y  ' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('X');
    expect(records[0]?.artist_aliases).toEqual(['Y']);
  });

  it('dedupes "X｜Y｜Y" to a single alias', () => {
    const r = record({ artist_primary: 'X｜Y｜Y' });
    const { records, warnings } = resolveArtistAliases([r]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('X');
    expect(records[0]?.artist_aliases).toEqual(['Y']);
  });
});

describe('resolveArtistAliases — Phase 3 bare-record rewrite', () => {
  it('rewrites bare "Spitz" to "スピッツ" when corpus seeds "スピッツ｜Spitz"', () => {
    const seed = record({
      id: 'blog-100-0',
      artist_primary: 'スピッツ｜Spitz',
    });
    const bare = record({
      id: 'tj-200',
      artist_primary: 'Spitz',
    });
    const { records, warnings } = resolveArtistAliases([seed, bare]);
    expect(warnings).toHaveLength(0);

    const seedOut = records.find((r) => r.id === 'blog-100-0');
    const bareOut = records.find((r) => r.id === 'tj-200');
    expect(seedOut?.artist_primary).toBe('スピッツ');
    expect(seedOut?.artist_aliases).toEqual(['Spitz']);
    expect(bareOut?.artist_primary).toBe('スピッツ');
    expect(bareOut?.artist_aliases).toEqual(['Spitz']);
  });

  it('passes through bare "Random" unchanged when no alias map matches', () => {
    const seed = record({
      id: 'blog-100-0',
      artist_primary: 'スピッツ｜Spitz',
    });
    const other = record({
      id: 'tj-300',
      artist_primary: 'Random',
    });
    const { records, warnings } = resolveArtistAliases([seed, other]);
    expect(warnings).toHaveLength(0);
    const otherOut = records.find((r) => r.id === 'tj-300');
    expect(otherOut?.artist_primary).toBe('Random');
    expect(otherOut?.artist_aliases).toBeUndefined();
  });

  it('propagates known aliases onto a bare-canonical record (search coverage enhancement)', () => {
    const seed = record({
      id: 'blog-100-0',
      artist_primary: 'スピッツ｜Spitz',
    });
    const bareCanonical = record({
      id: 'tj-400',
      artist_primary: 'スピッツ',
    });
    const { records, warnings } = resolveArtistAliases([seed, bareCanonical]);
    expect(warnings).toHaveLength(0);
    const out = records.find((r) => r.id === 'tj-400');
    // The bare-canonical record adopts the canonical's known aliases so a
    // search for "Spitz" reaches every record under that canonical (closes
    // the spec §6 search-coverage gap on bare-canonical inputs).
    expect(out?.artist_primary).toBe('スピッツ');
    expect(out?.artist_aliases).toEqual(['Spitz']);
  });

  it('leaves a bare-canonical record alone when the canonical has no known aliases', () => {
    const lone = record({
      id: 'tj-500',
      artist_primary: 'BUMP OF CHICKEN',
    });
    const { records, warnings } = resolveArtistAliases([lone]);
    expect(warnings).toHaveLength(0);
    expect(records[0]?.artist_primary).toBe('BUMP OF CHICKEN');
    expect(records[0]?.artist_aliases).toBeUndefined();
  });
});

describe('resolveArtistAliases — Phase 2 collision detection', () => {
  it('leaves both pipe-form records split, but blocks bare re-key on collision', () => {
    const a = record({
      id: 'blog-1000-0',
      artist_primary: 'Aimer (Visual Artist)｜Aimer',
    });
    const b = record({
      id: 'blog-2000-0',
      artist_primary: 'Aimer (Singer)｜Aimer',
    });
    const bare = record({
      id: 'tj-9999',
      artist_primary: 'Aimer',
    });
    const { records, warnings } = resolveArtistAliases([a, b, bare]);

    // Both pipe-form records still got split (Phase 1 is unconditional).
    const aOut = records.find((r) => r.id === 'blog-1000-0');
    const bOut = records.find((r) => r.id === 'blog-2000-0');
    expect(aOut?.artist_primary).toBe('Aimer (Visual Artist)');
    expect(aOut?.artist_aliases).toEqual(['Aimer']);
    expect(bOut?.artist_primary).toBe('Aimer (Singer)');
    expect(bOut?.artist_aliases).toEqual(['Aimer']);

    // Bare record left untouched.
    const bareOut = records.find((r) => r.id === 'tj-9999');
    expect(bareOut?.artist_primary).toBe('Aimer');
    expect(bareOut?.artist_aliases).toBeUndefined();

    // Collision warning enumerates both canonicals.
    const collision = warnings.find((w) => w.canonicals.length === 2);
    expect(collision).toBeDefined();
    expect(collision?.alias).toBe('Aimer');
    expect(collision?.canonicals.sort()).toEqual(
      ['Aimer (Singer)', 'Aimer (Visual Artist)'].sort(),
    );
    expect(collision?.affected).toBe(1);
  });
});

describe('resolveArtistAliases — input immutability', () => {
  it('does not mutate the input records', () => {
    const r = record({
      id: 'blog-1-0',
      artist_primary: 'X｜Y',
    });
    const before = JSON.parse(JSON.stringify(r));
    resolveArtistAliases([r]);
    expect(r).toEqual(before);
  });
});

describe('resolveArtistAliases — idempotence', () => {
  it('a second pass produces byte-identical output (Phase 1 no-op on canonical, Phase 3 skip on bareKey===canonicalKey)', () => {
    const seed = record({
      id: 'blog-100-0',
      artist_primary: 'スピッツ｜Spitz',
    });
    const bare = record({
      id: 'tj-200',
      artist_primary: 'Spitz',
    });
    const first = resolveArtistAliases([seed, bare]);
    const second = resolveArtistAliases(first.records);
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
  });
});
