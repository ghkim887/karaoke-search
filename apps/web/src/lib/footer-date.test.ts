import { describe, expect, it } from 'vitest';
import { formatDbDate } from './footer-date.js';

describe('formatDbDate', () => {
  it('returns the trimmed git short-ISO date when git output is non-empty', () => {
    expect(formatDbDate('2026-04-28\n', undefined)).toBe('2026-04-28');
  });

  it('falls back to SOURCE_DATE_EPOCH formatted as YYYY-MM-DD UTC', () => {
    // 2026-04-28T12:34:56Z = 1777379696
    expect(formatDbDate('', '1777379696')).toBe('2026-04-28');
  });

  it('returns empty string when both inputs are missing', () => {
    expect(formatDbDate('', undefined)).toBe('');
  });

  it('returns empty string when both inputs are unparseable', () => {
    expect(formatDbDate('', 'not-a-number')).toBe('');
  });
});
