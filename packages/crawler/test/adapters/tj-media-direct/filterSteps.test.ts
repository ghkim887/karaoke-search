/**
 * Unit tests for the typed FilterStep[] reducer (filterSteps.ts).
 *
 * Coverage:
 *   - Each step's evaluate() in isolation: admit / reject / pass cases
 *   - The reducer correctly short-circuits on first non-pass verdict
 *   - FILTER_STEPS contains all 5 expected step names in documented order
 *   - blog-rescue step is reachable (NOT dead code)
 */
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import {
  FILTER_STEPS,
  buildFilterContext,
  type FilterContext,
} from '../../../src/adapters/tj-media-direct/filterSteps.js';
import { splitArtistCollab } from '../../../src/adapters/tj-media-direct/normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    tj: '1',
    artist: 'TestArtist',
    components: splitArtistCollab('TestArtist'),
    cache: emptyCache(),
    force: undefined,
    ...overrides,
  };
}

function jpnArtistEntry() {
  return { code: 'JPN' as const, votes: { JPN: 3, KOR: 0, ENG: 0 }, lastSeen: '2026-04-29T00:00:00.000Z' };
}

function enrichmentEntry(nationalcode: string) {
  return {
    nationalcode,
    sortTitleKo: null,
    sortSongKo: null,
    subTitle: null,
    publishdate: null,
    lastSeen: '2026-04-29T00:00:00.000Z',
  };
}

// Convenience: find a step by name (fails fast if the step is missing)
function getStep(name: string) {
  const step = FILTER_STEPS.find((s) => s.name === name);
  if (!step) throw new Error(`FilterStep "${name}" not found in FILTER_STEPS`);
  return step;
}

// ---------------------------------------------------------------------------
// FILTER_STEPS shape + ordering
// ---------------------------------------------------------------------------

describe('FILTER_STEPS — pipeline shape', () => {
  const EXPECTED_NAMES = [
    'drop-list-reject',
    'kor-reject',
    'jpn-admit-artist',
    'jpn-admit-pro',
    'blog-rescue',
  ];

  it('contains exactly 5 steps', () => {
    expect(FILTER_STEPS).toHaveLength(5);
  });

  it('step names match the documented CLAUDE.md order', () => {
    expect(FILTER_STEPS.map((s) => s.name)).toEqual(EXPECTED_NAMES);
  });

  it('blog-rescue is reachable (step is present in FILTER_STEPS)', () => {
    // CLAUDE.md gotcha: "blog rescue is the safety net, NOT dead code"
    expect(FILTER_STEPS.some((s) => s.name === 'blog-rescue')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 0: drop-list-reject
// ---------------------------------------------------------------------------

describe('drop-list-reject step', () => {
  const step = getStep('drop-list-reject');

  it('returns reject for a known Korean act (방탄소년단)', () => {
    const ctx = makeCtx({ artist: '방탄소년단', components: splitArtistCollab('방탄소년단') });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('reject');
    if (v.decision === 'reject') expect(v.reason).toBe('korean-drop-list');
  });

  it('returns reject for a known Cantopop act (BEYOND)', () => {
    const ctx = makeCtx({ artist: 'BEYOND', components: splitArtistCollab('BEYOND') });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('reject');
    if (v.decision === 'reject') expect(v.reason).toBe('chinese-drop-list');
  });

  it('returns reject when a drop-list member appears as a featured component (any-component rule)', () => {
    // e.g. "MAX(Feat.SUGA of BTS)" — SUGA-of-BTS hits the drop list
    const artist = 'MAX(Feat.SUGA of BTS)';
    const ctx = makeCtx({ artist, components: splitArtistCollab(artist) });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('reject');
  });

  it('returns pass for a Japanese act not on any drop list (LiSA)', () => {
    const ctx = makeCtx({ artist: 'LiSA', components: splitArtistCollab('LiSA') });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('pass');
  });

  it('returns pass for an unknown Latin artist', () => {
    const ctx = makeCtx({ artist: 'GRANRODEO', components: splitArtistCollab('GRANRODEO') });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Step 1: kor-reject
// ---------------------------------------------------------------------------

describe('kor-reject step', () => {
  const step = getStep('kor-reject');

  it('returns reject when proEnrichmentMap[tj] has nationalcode KOR', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('KOR');
    const ctx = makeCtx({ tj: '99', cache });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('reject');
    if (v.decision === 'reject') expect(v.reason).toBe('pro-kor');
  });

  it('returns pass when proEnrichmentMap[tj] has nationalcode JPN', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('JPN');
    const ctx = makeCtx({ tj: '99', cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when proEnrichmentMap has no entry for tj', () => {
    const ctx = makeCtx({ tj: '99', cache: emptyCache() });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when nationalcode is null', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry(null as unknown as string);
    const ctx = makeCtx({ tj: '99', cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Step 2: jpn-admit-artist
// ---------------------------------------------------------------------------

describe('jpn-admit-artist step', () => {
  const step = getStep('jpn-admit-artist');

  it('returns admit(artist) when the lead component is JPN-tagged', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtistEntry();
    const ctx = makeCtx({ artist: 'YOASOBI', components: splitArtistCollab('YOASOBI'), cache });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('artist');
  });

  it('returns admit(artist) for a collab when the LEAD is JPN-tagged', () => {
    // splitArtistCollab('imase & なとり') → [whole, 'imase', 'なとり']
    // lead = components[1] = 'imase'
    const cache = emptyCache();
    cache.artistNationalityMap.imase = jpnArtistEntry();
    const ctx = makeCtx({ artist: 'imase & なとり', components: splitArtistCollab('imase & なとり'), cache });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('artist');
  });

  it('returns pass when only the featured artist is JPN-tagged (lead is non-JPN)', () => {
    // Charlie Puth(Feat.宇多田ヒカル) — lead is 'charlie puth', not JPN
    const cache = emptyCache();
    cache.artistNationalityMap['宇多田ヒカル'] = jpnArtistEntry();
    const artist = 'Charlie Puth(Feat.宇多田ヒカル)';
    const ctx = makeCtx({ artist, components: splitArtistCollab(artist), cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when the lead artist is KOR-tagged', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.koract = {
      code: 'KOR',
      votes: { JPN: 0, KOR: 3, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const ctx = makeCtx({ artist: 'KorAct', components: splitArtistCollab('KorAct'), cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when the lead artist is AMBIGUOUS-tagged (only JPN admits)', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = {
      code: 'AMBIGUOUS',
      votes: { JPN: 1, KOR: 1, ENG: 0 },
      lastSeen: '2026-04-29T00:00:00.000Z',
    };
    const ctx = makeCtx({ artist: 'YOASOBI', components: splitArtistCollab('YOASOBI'), cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when components is empty', () => {
    const ctx = makeCtx({ components: [] });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Step 3: jpn-admit-pro
// ---------------------------------------------------------------------------

describe('jpn-admit-pro step', () => {
  const step = getStep('jpn-admit-pro');

  it('returns admit(pro) when proEnrichmentMap[tj] has nationalcode JPN', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['42'] = enrichmentEntry('JPN');
    const ctx = makeCtx({ tj: '42', cache });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('pro');
  });

  it('returns pass when proEnrichmentMap has no entry for tj', () => {
    const ctx = makeCtx({ tj: '42', cache: emptyCache() });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when nationalcode is KOR', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['42'] = enrichmentEntry('KOR');
    const ctx = makeCtx({ tj: '42', cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when nationalcode is null', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['42'] = enrichmentEntry(null as unknown as string);
    const ctx = makeCtx({ tj: '42', cache });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Step 4: blog-rescue
// ---------------------------------------------------------------------------

describe('blog-rescue step', () => {
  const step = getStep('blog-rescue');

  it('returns admit(rescue) when tj is in the force set', () => {
    const ctx = makeCtx({ tj: '99', force: new Set(['99']) });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('rescue');
  });

  it('returns pass when tj is NOT in the force set', () => {
    const ctx = makeCtx({ tj: '99', force: new Set(['1', '2']) });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when force is undefined', () => {
    const ctx = makeCtx({ tj: '99', force: undefined });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it('returns pass when force is an empty set', () => {
    const ctx = makeCtx({ tj: '99', force: new Set<string>() });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Reducer short-circuit semantics
// ---------------------------------------------------------------------------

describe('reducer short-circuit semantics', () => {
  it('stops at drop-list-reject and does NOT continue to kor-reject or admit steps', () => {
    // BTS is on the Korean drop list. Even if we also put a JPN pro entry in
    // the cache, the drop-list step fires first and the result is drop.
    const cache = emptyCache();
    cache.proEnrichmentMap['1'] = enrichmentEntry('JPN');
    cache.artistNationalityMap.bts = jpnArtistEntry();
    const ctx = buildFilterContext('1', 'BTS', cache, new Set(['1']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    // Should stop after step 0 (drop-list-reject)
    expect(stepsReached).toBe(1);
  });

  it('stops at kor-reject and does NOT continue to admit steps', () => {
    // KOR-tagged pro should stop at step 1.
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('KOR');
    cache.artistNationalityMap.yoasobi = jpnArtistEntry();
    const ctx = buildFilterContext('99', 'YOASOBI', cache, new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    // Should stop after step 1 (kor-reject)
    expect(stepsReached).toBe(2);
  });

  it('stops at jpn-admit-artist (step 2) and does NOT reach pro or rescue', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtistEntry();
    const ctx = buildFilterContext('99', 'YOASOBI', cache, new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    // Should stop after step 2 (jpn-admit-artist)
    expect(stepsReached).toBe(3);
  });

  it('stops at jpn-admit-pro (step 3) when artist step passes', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('JPN');
    // No artist entry — step 2 passes, step 3 admits
    const ctx = buildFilterContext('99', 'UnknownAct', cache, new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    expect(stepsReached).toBe(4);
  });

  it('reaches blog-rescue (step 4) only when all prior steps pass', () => {
    // Empty cache + unknown artist + rescue whitelist → only rescue fires
    const ctx = buildFilterContext('99', 'UnknownAct', emptyCache(), new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    expect(stepsReached).toBe(5);
  });

  it('falls through all steps with pass and returns drop when nothing admits', () => {
    const ctx = buildFilterContext('99', 'UnknownAct', emptyCache(), undefined);
    let allPass = true;
    for (const step of FILTER_STEPS) {
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') { allPass = false; break; }
    }
    expect(allPass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFilterContext
// ---------------------------------------------------------------------------

describe('buildFilterContext', () => {
  it('pre-computes components from artist string', () => {
    const ctx = buildFilterContext('1', 'imase & なとり', emptyCache(), undefined);
    // splitArtistCollab always places whole string at index 0
    expect(ctx.components[0]).toBe('imase & なとり');
    expect(ctx.components.length).toBeGreaterThan(1);
  });

  it('preserves force set reference', () => {
    const force = new Set(['1', '2']);
    const ctx = buildFilterContext('1', 'artist', emptyCache(), force);
    expect(ctx.force).toBe(force);
  });

  it('force is undefined when not passed', () => {
    const ctx = buildFilterContext('1', 'artist', emptyCache());
    expect(ctx.force).toBeUndefined();
  });
});
