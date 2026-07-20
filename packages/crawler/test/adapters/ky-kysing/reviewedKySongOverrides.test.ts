import { describe, expect, it } from 'vitest';
import {
  REVIEWED_KY_ALLOW_NUMBERS,
  REVIEWED_KY_DROP_ENTRIES,
  type ReviewedKyOverrideEntry,
  isReviewedKyAllow,
  isReviewedKyDrop,
} from '../../../src/adapters/ky-kysing/reviewedKySongOverrides.js';

describe('reviewedKySongOverrides', () => {
  it('allow stays EMPTY; drop carries the 2026-07-20 leak-triage entry (ky 51322)', () => {
    expect(REVIEWED_KY_ALLOW_NUMBERS).toHaveLength(0);
    expect(REVIEWED_KY_DROP_ENTRIES).toHaveLength(1);
    // CUTIE STREET Korean-language row — the KY-side claim for the same song as
    // the TJ-side drop tj 52093.
    expect(isReviewedKyDrop('51322')).toBe(true);
    expect(isReviewedKyAllow('51322')).toBe(false);
    // The JP original's KY number (57750) stays admittable.
    expect(isReviewedKyDrop('57750')).toBe(false);
  });

  it('predicates return false for non-member numbers', () => {
    for (const ky of ['44655', '1', '999999', '', '  ', 'not-a-number']) {
      expect(isReviewedKyAllow(ky)).toBe(false);
      expect(isReviewedKyDrop(ky)).toBe(false);
    }
  });

  it('a DROP entry (when added) carries auditable metadata', () => {
    // Shape guard so a future entry cannot be added without the audit fields.
    const sample: ReviewedKyOverrideEntry = {
      ky: '12345',
      title: 'Example',
      artist: 'Example Artist',
      decidedOn: '2026-07-16',
      note: 'illustrative only — not a real override',
    };
    expect(sample.ky).toMatch(/^[0-9]+$/);
    expect(sample.decidedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Every real entry must normalize its key the same way the predicate probes.
    for (const entry of REVIEWED_KY_DROP_ENTRIES) {
      expect(isReviewedKyDrop(entry.ky)).toBe(true);
    }
  });
});
