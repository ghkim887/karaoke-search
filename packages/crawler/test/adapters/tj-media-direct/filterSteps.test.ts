/**
 * Unit tests for the typed FilterStep[] reducer (filterSteps.ts).
 *
 * Coverage:
 *   - Each step's evaluate() in isolation: admit / reject / pass cases
 *   - The reducer correctly short-circuits on first non-pass verdict
 *   - FILTER_STEPS contains all 7 expected step names in documented order
 *   - drop-list-reject precedes the JPN admit paths (KPOP-leak regression)
 *   - blog-rescue step is reachable (NOT dead code)
 */
import { describe, expect, it } from 'vitest';
import { emptyCache } from '../../../src/adapters/tj-media-direct/cache.js';
import {
  FILTER_STEPS,
  type FilterContext,
  type FilterStep,
  buildFilterContext,
} from '../../../src/adapters/tj-media-direct/filterSteps.js';
import { splitArtistCollab } from '../../../src/adapters/tj-media-direct/normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    tj: '1',
    title: 'TestTitle',
    artist: 'TestArtist',
    components: splitArtistCollab('TestArtist'),
    cache: emptyCache(),
    force: undefined,
    ...overrides,
  };
}

function jpnArtistEntry() {
  return {
    code: 'JPN' as const,
    votes: { JPN: 3, KOR: 0, ENG: 0 },
    lastSeen: '2026-04-29T00:00:00.000Z',
  };
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

function runReducer(
  tj: string,
  artist: string,
  cache = emptyCache(),
  force?: ReadonlySet<string>,
  title = '',
) {
  const ctx = buildFilterContext(tj, title, artist, cache, force);
  for (const step of FILTER_STEPS) {
    const verdict = step.evaluate(ctx);
    if (verdict.decision === 'admit') return verdict.via;
    if (verdict.decision === 'reject') return 'drop';
  }
  return 'drop';
}

type FilterVerdict = ReturnType<FilterStep['evaluate']>;

/**
 * Run the pipeline, recording each step name reached into `reached`, and return
 * the first non-pass verdict (or the final pass verdict if every step passed).
 */
function runVerdict(ctx: FilterContext, reached: string[]): FilterVerdict {
  let verdict: FilterVerdict = { decision: 'pass' };
  for (const step of FILTER_STEPS) {
    reached.push(step.name);
    verdict = step.evaluate(ctx);
    if (verdict.decision !== 'pass') break;
  }
  return verdict;
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
    'reviewed-song-drop',
    'non-jpn-pro-reject',
    'reviewed-song-allow',
    'drop-list-reject',
    'jpn-admit-pro',
    'jpn-admit-artist',
    'blog-rescue',
  ];

  it('contains exactly 7 steps', () => {
    expect(FILTER_STEPS).toHaveLength(7);
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
// Step 3: drop-list-reject
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
// Step 1: non-jpn-pro-reject
// ---------------------------------------------------------------------------

describe('non-jpn-pro-reject step', () => {
  const step = getStep('non-jpn-pro-reject');

  it('returns reject when proEnrichmentMap[tj] has nationalcode KOR', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('KOR');
    const ctx = makeCtx({ tj: '99', cache });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('reject');
    if (v.decision === 'reject') expect(v.reason).toBe('pro-non-jpn');
  });

  it('returns reject when proEnrichmentMap[tj] has an explicit non-JPN nationalcode', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('ENG');
    const ctx = makeCtx({ tj: '99', cache, force: new Set(['99']) });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('reject');
    if (v.decision === 'reject') expect(v.reason).toBe('pro-non-jpn');
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
// Step 5: jpn-admit-artist
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
    const ctx = makeCtx({
      artist: 'imase & なとり',
      components: splitArtistCollab('imase & なとり'),
      cache,
    });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('artist');
  });

  it('returns pass when only the featured artist is JPN-tagged (lead is non-JPN)', () => {
    // Charlie Puth(Feat.宇多田ヒカル) — lead is 'charlie puth', not JPN
    const cache = emptyCache();
    cache.artistNationalityMap.宇多田ヒカル = jpnArtistEntry();
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
// Step 5: jpn-admit-artist — filter-seam script guard (#97-gate discriminator)
// ---------------------------------------------------------------------------

describe('jpn-admit-artist step — filter-seam script guard', () => {
  const step = getStep('jpn-admit-artist');

  it('vetoes an artist-vote admit when the row reads as Korean script (Hangul, no Japanese)', () => {
    // Synthetic Korean act NOT on any drop list, mis-tagged JPN by the artist
    // scan (the lagging-signal seam). Without the guard, jpn-admit-artist would
    // admit via 'artist'; the guard makes the step fall through instead.
    const cache = emptyCache();
    cache.artistNationalityMap.가상밴드 = jpnArtistEntry();
    const artist = '가상밴드';
    const ctx = makeCtx({
      title: '가상의 노래',
      artist,
      components: splitArtistCollab(artist),
      cache,
    });
    expect(step.evaluate(ctx).decision).toBe('pass');
  });

  it("still admits a Japanese-titled row via 'artist' (Ado「ビバリウム」 — the real measured case)", () => {
    // Kana title + Latin artist: no Hangul in `${title} ${artist}` → the guard
    // is a no-op → normal artist admit. This is the one admit-via-artist row
    // measured in the 2026-07-13 verification crawl.
    const cache = emptyCache();
    cache.artistNationalityMap.ado = jpnArtistEntry();
    const ctx = makeCtx({
      title: 'ビバリウム',
      artist: 'Ado',
      components: splitArtistCollab('Ado'),
      cache,
    });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('artist');
  });

  it('does not veto a mixed-script row that also carries Japanese script (kanji/kana present)', () => {
    // `${title} ${artist}` has Hangul AND Japanese script → NOT a Korean-script
    // row by the #97 discriminator → the admit stands. Guards against the guard
    // over-firing on genuine JP rows that happen to carry a Hangul gloss.
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtistEntry();
    const ctx = makeCtx({
      title: '밤에 달리다 (夜に駆ける)',
      artist: 'YOASOBI',
      components: splitArtistCollab('YOASOBI'),
      cache,
    });
    const v = step.evaluate(ctx);
    expect(v.decision).toBe('admit');
    if (v.decision === 'admit') expect(v.via).toBe('artist');
  });
});

// ---------------------------------------------------------------------------
// Step 4: jpn-admit-pro
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
// Step 6: blog-rescue
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
  it('rejects a drop-listed Korean act with a JPN pro tag before jpn-admit-pro can leak it', () => {
    // KPOP-leak regression: a drop-listed act (BTS) carrying a JPN pro tag and
    // NOT curated into reviewed-song-allow must be rejected at drop-list-reject
    // (step 3) BEFORE jpn-admit-pro (step 4) admits it. Pre-fix, jpn-admit-pro
    // ran before drop-list-reject and leaked this row into the corpus.
    const cache = emptyCache();
    cache.proEnrichmentMap['999999'] = enrichmentEntry('JPN');
    cache.artistNationalityMap.bts = jpnArtistEntry();
    const ctx = buildFilterContext('999999', '', 'BTS', cache, new Set(['999999']));

    const reached: string[] = [];
    const finalVerdict = runVerdict(ctx, reached);
    expect(finalVerdict.decision).toBe('reject');
    if (finalVerdict.decision === 'reject') {
      expect(finalVerdict.reason).toBe('korean-drop-list');
    }
    expect(reached).toEqual([
      'reviewed-song-drop',
      'non-jpn-pro-reject',
      'reviewed-song-allow',
      'drop-list-reject',
    ]);
  });

  it('admits a drop-listed act via reviewed-song-allow before the drop-list deny', () => {
    // A drop-listed artist (BTS = 防弾少年団) whose TJ number IS curated into
    // REVIEWED_TJ_SONG_ALLOW is admitted at reviewed-song-allow (step 2),
    // BEFORE drop-list-reject (step 3) — so the 112 curated K-pop Japanese
    // releases still get in even though the artist is on the drop list.
    const cache = emptyCache();
    cache.proEnrichmentMap['68048'] = enrichmentEntry('JPN');
    const ctx = buildFilterContext('68048', '', 'BTS', cache, new Set(['68048']));

    const reached: string[] = [];
    const finalVerdict = runVerdict(ctx, reached);
    expect(finalVerdict.decision).toBe('admit');
    if (finalVerdict.decision === 'admit') {
      expect(finalVerdict.via).toBe('song-override');
    }
    expect(reached).toEqual(['reviewed-song-drop', 'non-jpn-pro-reject', 'reviewed-song-allow']);
  });

  it('stops at non-jpn-pro-reject and does NOT continue to admit steps', () => {
    // Non-JPN-tagged pro should stop at step 1.
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('ENG');
    cache.artistNationalityMap.yoasobi = jpnArtistEntry();
    const ctx = buildFilterContext('99', '', 'YOASOBI', cache, new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    // Should stop after step 1 in the new pipeline (reviewed drop, then non-JPN reject).
    expect(stepsReached).toBe(2);
  });

  it('stops at jpn-admit-artist (step 5) and does NOT reach rescue', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.yoasobi = jpnArtistEntry();
    const ctx = buildFilterContext('99', '', 'YOASOBI', cache, new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    // reviewed drop + non-JPN + reviewed allow + deny pass + pro pass + artist admit
    expect(stepsReached).toBe(6);
  });

  it('stops at jpn-admit-pro (step 4) when drop-list and artist steps pass', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['99'] = enrichmentEntry('JPN');
    // No artist entry — drop-list passes, pro admits before jpn-admit-artist.
    const ctx = buildFilterContext('99', '', 'UnknownAct', cache, new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    // reviewed drop + non-JPN + reviewed allow + drop-list pass + pro admit
    expect(stepsReached).toBe(5);
  });

  it('reaches blog-rescue (step 6) only when all prior steps pass', () => {
    // Empty cache + unknown artist + rescue whitelist → only rescue fires
    const ctx = buildFilterContext('99', '', 'UnknownAct', emptyCache(), new Set(['99']));

    let stepsReached = 0;
    for (const step of FILTER_STEPS) {
      stepsReached++;
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') break;
    }
    expect(stepsReached).toBe(7);
  });

  it('lets a reviewed K-pop/Korean song-level allow beat the drop-list without artist-wide admission', () => {
    expect(runReducer('28779', 'BTS', emptyCache())).toBe('song-override');
  });

  it('keeps explicit non-JPN pro evidence stronger than a reviewed song-level allow', () => {
    const cache = emptyCache();
    cache.proEnrichmentMap['26544'] = enrichmentEntry('KOR');
    expect(runReducer('26544', '東方神起', cache)).toBe('drop');
  });

  it('keeps reviewed generic false-positive drops stronger than artist cache and rescue', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.variousartists = jpnArtistEntry();
    expect(runReducer('7055', 'Various Artists', cache, new Set(['7055']))).toBe('drop');
  });

  it('blocks generic artists from weak artist-cache or rescue admission without song-level evidence', () => {
    const cache = emptyCache();
    cache.artistNationalityMap.variousartists = jpnArtistEntry();
    expect(runReducer('999999', 'Various Artists', cache, new Set(['999999']))).toBe('drop');
  });

  it('still blocks a drop-listed Korean act from weak rescue when no song-level evidence exists', () => {
    expect(runReducer('999999', 'BTS', emptyCache(), new Set(['999999']))).toBe('drop');
  });

  it('falls through all steps with pass and returns drop when nothing admits', () => {
    const ctx = buildFilterContext('99', '', 'UnknownAct', emptyCache(), undefined);
    let allPass = true;
    for (const step of FILTER_STEPS) {
      const v = step.evaluate(ctx);
      if (v.decision !== 'pass') {
        allPass = false;
        break;
      }
    }
    expect(allPass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFilterContext
// ---------------------------------------------------------------------------

describe('buildFilterContext', () => {
  it('pre-computes components from artist string', () => {
    const ctx = buildFilterContext('1', 'SomeTitle', 'imase & なとり', emptyCache(), undefined);
    // splitArtistCollab always places whole string at index 0
    expect(ctx.components[0]).toBe('imase & なとり');
    expect(ctx.components.length).toBeGreaterThan(1);
  });

  it('carries the raw title through unchanged (used by the jpn-admit-artist guard)', () => {
    const ctx = buildFilterContext('1', 'ビバリウム', 'Ado', emptyCache(), undefined);
    expect(ctx.title).toBe('ビバリウム');
  });

  it('preserves force set reference', () => {
    const force = new Set(['1', '2']);
    const ctx = buildFilterContext('1', 'SomeTitle', 'artist', emptyCache(), force);
    expect(ctx.force).toBe(force);
  });

  it('force is undefined when not passed', () => {
    const ctx = buildFilterContext('1', 'SomeTitle', 'artist', emptyCache());
    expect(ctx.force).toBeUndefined();
  });
});
