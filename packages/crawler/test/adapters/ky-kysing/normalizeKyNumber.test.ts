import { describe, expect, it } from 'vitest';
import {
  KY_NUMBER_MAX_DIGITS,
  normalizeKyNumber,
} from '../../../src/adapters/ky-kysing/normalizeKyNumber.js';

describe('normalizeKyNumber', () => {
  it('returns bare digits unchanged (canonical form)', () => {
    expect(normalizeKyNumber('41905')).toBe('41905');
    expect(normalizeKyNumber('1')).toBe('1');
    expect(normalizeKyNumber('123456')).toBe('123456');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeKyNumber('  44418 ')).toBe('44418');
  });

  it('preserves leading zeros (verbatim match with the blog cell)', () => {
    // Leading zeros are NOT stripped: the blog cell and the KY index both
    // render verbatim, and Tier A union is exact-string-match.
    expect(normalizeKyNumber('041905')).toBe('041905');
  });

  it('rejects non-digit input', () => {
    expect(normalizeKyNumber('')).toBeNull();
    expect(normalizeKyNumber('   ')).toBeNull();
    expect(normalizeKyNumber('12a34')).toBeNull();
    expect(normalizeKyNumber('190-001')).toBeNull(); // hyphens are not KY form
    expect(normalizeKyNumber('등록일')).toBeNull();
  });

  it('rejects a value longer than the digit cap', () => {
    expect(KY_NUMBER_MAX_DIGITS).toBe(6);
    expect(normalizeKyNumber('1234567')).toBeNull(); // 7 digits > cap 6
    expect(normalizeKyNumber('123456')).toBe('123456'); // exactly the cap
  });
});
