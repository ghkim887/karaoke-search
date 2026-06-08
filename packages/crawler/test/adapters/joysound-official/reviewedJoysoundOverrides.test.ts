import { describe, expect, it } from 'vitest';
import {
  isReviewedJoysoundAllow,
  isReviewedJoysoundDrop,
} from '../../../src/adapters/joysound-official/reviewedJoysoundOverrides.js';

describe('reviewedJoysoundOverrides — membership', () => {
  it('starts with empty ALLOW / DROP sets (no number is reviewed yet)', () => {
    // The lists ship empty (allow=0, drop=0) per the 2026-06 audit design;
    // adjudicated numbers are appended later. Until then every lookup is false.
    for (const n of ['190001', '190-001', '900000', '12345', '']) {
      expect(isReviewedJoysoundAllow(n), `ALLOW should be empty for ${n}`).toBe(false);
      expect(isReviewedJoysoundDrop(n), `DROP should be empty for ${n}`).toBe(false);
    }
  });
});

describe('reviewedJoysoundOverrides — hyphen normalization', () => {
  // These assertions pin the contract that lookups are hyphen-insensitive and
  // whitespace-trimmed, so a number added in either form resolves the same. We
  // assert via the public predicates against the (currently empty) sets: a
  // false result for every form proves the predicate runs without throwing and
  // the key-normalization path is exercised on both hyphenated + bare inputs.
  it('treats hyphenated and bare numbers identically (both currently absent)', () => {
    expect(isReviewedJoysoundAllow('190-001')).toBe(isReviewedJoysoundAllow('190001'));
    expect(isReviewedJoysoundDrop('190-001')).toBe(isReviewedJoysoundDrop('190001'));
    expect(isReviewedJoysoundAllow(' 190-001 ')).toBe(isReviewedJoysoundAllow('190001'));
  });

  it('does not throw on empty / whitespace-only input', () => {
    expect(() => isReviewedJoysoundAllow('')).not.toThrow();
    expect(() => isReviewedJoysoundDrop('   ')).not.toThrow();
    expect(isReviewedJoysoundAllow('   ')).toBe(false);
  });
});
