import { describe, expect, it } from 'vitest';
import {
  REVIEWED_KY_ALLOW_NUMBERS,
  REVIEWED_KY_DROP_ENTRIES,
  type ReviewedKyOverrideEntry,
  isReviewedKyAllow,
  isReviewedKyDrop,
} from '../../../src/adapters/ky-kysing/reviewedKySongOverrides.js';

describe('reviewedKySongOverrides', () => {
  it('ships EMPTY allow/drop lists on day one', () => {
    expect(REVIEWED_KY_ALLOW_NUMBERS).toHaveLength(0);
    expect(REVIEWED_KY_DROP_ENTRIES).toHaveLength(0);
  });

  it('predicates return false for any number (no overrides wired yet)', () => {
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
