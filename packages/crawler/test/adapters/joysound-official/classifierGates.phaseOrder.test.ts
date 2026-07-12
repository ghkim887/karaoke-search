/**
 * Order-regression tests for the JOYSOUND classify gate-array phase mechanism.
 *
 * The golden gate (classifierGolden.test.ts) freezes the `{ admit, reason }`
 * verdict at every gate — it is the behaviour-identity gate. These tests assert
 * the STRUCTURAL guard that makes a reorder fail loudly: every gate carries a
 * `phase`, and assertPhaseOrder() (run at module load) throws unless
 * JOYSOUND_GATES is sorted by PHASE_ORDER. Before the gate-array restructure the
 * chain order lived only in a prose docblock and was pinned solely by the golden
 * gate; this makes the load-bearing order machine-checked at import time.
 *
 * Mirrors packages/crawler/test/adapters/tj-media-direct/filterSteps.phaseOrder.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  JOYSOUND_GATES,
  type JoysoundGate,
  PHASE_ORDER,
  assertPhaseOrder,
} from '../../../src/adapters/joysound-official/classifier.js';

describe('assertPhaseOrder — JOYSOUND gate phase-tag order guard', () => {
  it('the real JOYSOUND_GATES pipeline passes the guard', () => {
    expect(() => assertPhaseOrder(JOYSOUND_GATES)).not.toThrow();
  });

  it('every gate is tagged with a phase declared in PHASE_ORDER', () => {
    for (const gate of JOYSOUND_GATES) {
      expect(PHASE_ORDER).toContain(gate.phase);
    }
  });

  it('JOYSOUND_GATES phases are exactly PHASE_ORDER, in order', () => {
    // Each phase maps to one gate today, so the chain phase sequence must equal
    // the declared policy order verbatim. This is the canary that trips if a
    // gate is added, dropped, or re-tagged out of policy order.
    expect(JOYSOUND_GATES.map((g) => g.phase)).toEqual(PHASE_ORDER);
  });

  it('throws on the classic foreign-leak reorder (positive-cascade ahead of foreign-act)', () => {
    // Swapping foreign-act (a DROP gate) and positive-cascade (an ADMIT gate) is
    // the exact regression the load-bearing order exists to prevent: a
    // drop-listed foreign act with a kana title would be admitted before the
    // foreign-act gate could drop it. The guard must reject it.
    const denyIdx = JOYSOUND_GATES.findIndex((g) => g.phase === 'foreign-act');
    const admitIdx = JOYSOUND_GATES.findIndex((g) => g.phase === 'positive-cascade');
    const reordered = [...JOYSOUND_GATES];
    [reordered[denyIdx], reordered[admitIdx]] = [reordered[admitIdx], reordered[denyIdx]];

    expect(() => assertPhaseOrder(reordered)).toThrow(/order violation/);
  });

  it('throws when the terminal gate is moved before the override/foreign phases', () => {
    const terminal = JOYSOUND_GATES.find((g) => g.phase === 'terminal') as JoysoundGate;
    const reordered = [terminal, ...JOYSOUND_GATES.filter((g) => g !== terminal)];

    expect(() => assertPhaseOrder(reordered)).toThrow(/order violation/);
  });

  it('throws for a gate tagged with a phase not in PHASE_ORDER', () => {
    const bogus = {
      ...JOYSOUND_GATES[0],
      phase: 'not-a-real-phase',
    } as unknown as JoysoundGate;

    expect(() => assertPhaseOrder([bogus])).toThrow(/not in PHASE_ORDER/);
  });

  it('accepts a correctly ordered subset (non-decreasing, not strictly full)', () => {
    // The guard is non-decreasing over PHASE_ORDER rank, so any in-order subset
    // of the real gates is still valid.
    const subset = [
      JOYSOUND_GATES.find((g) => g.phase === 'override-drop'),
      JOYSOUND_GATES.find((g) => g.phase === 'foreign-act'),
      JOYSOUND_GATES.find((g) => g.phase === 'terminal'),
    ].filter((g): g is JoysoundGate => g !== undefined);

    expect(() => assertPhaseOrder(subset)).not.toThrow();
  });
});
