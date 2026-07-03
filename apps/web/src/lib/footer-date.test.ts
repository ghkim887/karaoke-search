import { describe, expect, it } from 'vitest';
import { maxCrawledDate } from './footer-date.js';

describe('maxCrawledDate', () => {
  it('returns the latest crawled_at truncated to YYYY-MM-DD', () => {
    expect(
      maxCrawledDate([
        '2026-01-01T00:00:00.000Z',
        '2026-04-28T12:34:56.000Z',
        '2026-01-03T23:59:59.000Z',
      ]),
    ).toBe('2026-04-28');
  });

  it('compares by date so a later day always wins regardless of time', () => {
    expect(maxCrawledDate(['2026-01-03T23:59:59.999Z', '2026-01-04T00:00:00.000Z'])).toBe(
      '2026-01-04',
    );
  });

  it('ignores missing and malformed values', () => {
    expect(maxCrawledDate([null, undefined, 'not-a-date', '', '2026-02-10T00:00:00.000Z'])).toBe(
      '2026-02-10',
    );
  });

  it('returns empty string for an empty corpus', () => {
    expect(maxCrawledDate([])).toBe('');
  });

  it('returns empty string when no value carries a usable date', () => {
    expect(maxCrawledDate([null, undefined, 'garbage'])).toBe('');
  });
});
