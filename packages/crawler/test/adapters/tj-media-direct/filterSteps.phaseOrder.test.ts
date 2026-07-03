/**
 * Order-regression tests for the phase-tag mechanism added in T2-3.
 *
 * The existing filterSteps.test.ts asserts the step *names* are in the
 * documented order. These tests assert the STRUCTURAL guard that makes a
 * reorder fail loudly: every step carries a `phase`, and assertPhaseOrder()
 * (run at module load) throws unless FILTER_STEPS is sorted by PHASE_ORDER.
 */
import { describe, expect, it } from 'vitest';
import {
  FILTER_STEPS,
  PHASE_ORDER,
  assertPhaseOrder,
  type FilterStep,
} from '../../../src/adapters/tj-media-direct/filterSteps.js';

describe('assertPhaseOrder — phase-tag order guard', () => {
  it('the real FILTER_STEPS pipeline passes the guard', () => {
    expect(() => assertPhaseOrder(FILTER_STEPS)).not.toThrow();
  });

  it('every step is tagged with a phase declared in PHASE_ORDER', () => {
    for (const step of FILTER_STEPS) {
      expect(PHASE_ORDER).toContain(step.phase);
    }
  });

  it('FILTER_STEPS phases are exactly PHASE_ORDER, in order', () => {
    // Each phase maps to one step today, so the chain phase sequence must equal
    // the declared policy order verbatim. This is the canary that trips if a
    // step is added, dropped, or re-tagged out of policy order.
    expect(FILTER_STEPS.map((s) => s.phase)).toEqual(PHASE_ORDER);
  });

  it('throws on the classic KPOP-leak reorder (admit-pro ahead of deny-list)', () => {
    // Swapping drop-list-reject (deny-list) and jpn-admit-pro (admit-pro) is the
    // exact regression the load-bearing order exists to prevent: a drop-listed
    // Korean act with a JPN pro tag would leak. The guard must reject it.
    const denyIdx = FILTER_STEPS.findIndex((s) => s.phase === 'deny-list');
    const proIdx = FILTER_STEPS.findIndex((s) => s.phase === 'admit-pro');
    const reordered = [...FILTER_STEPS];
    [reordered[denyIdx], reordered[proIdx]] = [reordered[proIdx], reordered[denyIdx]];

    expect(() => assertPhaseOrder(reordered)).toThrow(/order violation/);
  });

  it('throws when an admit step is moved before the deny/reject phases', () => {
    const rescue = FILTER_STEPS.find((s) => s.phase === 'rescue') as FilterStep;
    const reordered = [rescue, ...FILTER_STEPS.filter((s) => s !== rescue)];

    expect(() => assertPhaseOrder(reordered)).toThrow(/order violation/);
  });

  it('throws for a step tagged with a phase not in PHASE_ORDER', () => {
    const bogus = {
      ...FILTER_STEPS[0],
      phase: 'not-a-real-phase',
    } as unknown as FilterStep;

    expect(() => assertPhaseOrder([bogus])).toThrow(/not in PHASE_ORDER/);
  });

  it('accepts a correctly ordered subset (non-decreasing, not strictly full)', () => {
    // The guard is non-decreasing over PHASE_ORDER rank, so any in-order subset
    // of the real steps is still valid.
    const subset = [
      FILTER_STEPS.find((s) => s.phase === 'hard-drop'),
      FILTER_STEPS.find((s) => s.phase === 'deny-list'),
      FILTER_STEPS.find((s) => s.phase === 'rescue'),
    ].filter((s): s is FilterStep => s !== undefined);

    expect(() => assertPhaseOrder(subset)).not.toThrow();
  });
});
