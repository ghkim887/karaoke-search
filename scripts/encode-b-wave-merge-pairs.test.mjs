import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPlan,
  entryLines,
  loadReviews,
  parseArgs,
  parseReviewedSource,
} from './encode-b-wave-merge-pairs.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const REAL_REVIEWS = resolve(REPO_ROOT, 'scripts/data/b-review-merge-verdicts');
const REAL_SOURCE = resolve(REPO_ROOT, 'packages/crawler/src/reviewedMergePairs.ts');

const SAMPLE_SOURCE = `
const REVIEWED_TIER_E_STRONG_PAIRS = [
  ['6284', '1755'], // note
  ['25065', '999999'], // existing E owner of joysound 999999
] as const satisfies ReadonlyArray<readonly [string, string]>;

const EXPECTED_REVIEWED_TIER_E_STRONG_PAIR_COUNT = 2;
const REVIEWED_TIER_E_FORBIDDEN_PAIRS = new Set([
  '26121|65623',
  '26750|168779',
]);

const REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIRS = [
  ['tj', '52784', '634289'], // note
  ['ky', '44158', '689337'], // existing F ky owner
  ['tj', '25875', '888888'], // existing F tj owner of joysound 888888
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const EXPECTED_REVIEWED_TIER_F_POSTCRAWL_STRONG_PAIR_COUNT = 3;
const REVIEWED_TIER_F_FORBIDDEN_PAIRS = [
  ['tj', '6927', '19868'], // artist 19
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const REVIEWED_TIER_F_3WAY_ATTACH_PAIRS = [
  ['ky', '40141', '888888'], // existing attach: ky bridge onto tj-25875-owned joysound 888888
] as const satisfies ReadonlyArray<readonly [NonJoysoundVendor, string, string]>;

const EXPECTED_REVIEWED_TIER_F_3WAY_ATTACH_PAIR_COUNT = 1;
`;

function row(over) {
  return {
    song_id: 'tj-1',
    title: 'T',
    artist: 'A',
    tj: null,
    ky: null,
    J: '100',
    candTitle: 'T2',
    candArtist: 'A2',
    reason: '',
    ...over,
  };
}

describe('parseArgs', () => {
  it('defaults reviews/source and reads flags', () => {
    const a = parseArgs(['--out', 'o.txt', '--plan-out', 'p.json']);
    expect(a.out).toMatch(/o\.txt$/);
    expect(a.planOut).toMatch(/p\.json$/);
    expect(a.reviews).toMatch(/b-review-merge-verdicts$/);
  });
  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});

describe('parseReviewedSource', () => {
  const ex = parseReviewedSource(SAMPLE_SOURCE);
  it('extracts Tier E pairs and forbidden set', () => {
    expect(ex.tierE.get('6284')?.has('1755')).toBe(true);
    expect(ex.forbiddenE.has('26121|65623')).toBe(true);
  });
  it('extracts Tier F pairs and forbidden set', () => {
    expect(ex.tierF.get('tj:52784')?.has('634289')).toBe(true);
    expect(ex.tierF.get('ky:44158')?.has('689337')).toBe(true);
    expect(ex.forbiddenF.has('tj|6927|19868')).toBe(true);
  });
  it('collects every used joysound number across both tiers', () => {
    for (const j of ['1755', '999999', '634289', '689337', '888888'])
      expect(ex.existingJ.has(j)).toBe(true);
  });
  it('extracts the 3-way attach table (targets + joysounds)', () => {
    expect(ex.attach.get('ky:40141')?.has('888888')).toBe(true);
    expect(ex.attachTargets.has('ky:40141')).toBe(true);
    expect(ex.attachJ.has('888888')).toBe(true);
  });
});

describe('buildPlan tier assignment', () => {
  const ex = parseReviewedSource(SAMPLE_SOURCE);
  it('routes a single-vendor tj-only row to Tier F', () => {
    const p = buildPlan([row({ song_id: 'tj-500', tj: '500', J: '100' })], ex);
    expect(p.tierF).toHaveLength(1);
    expect(p.tierF[0]).toMatchObject({ v: 'tj', n: '500', J: '100' });
    expect(p.tierE).toHaveLength(0);
  });
  it('routes a single-vendor ky-only row to Tier F', () => {
    const p = buildPlan([row({ song_id: 'ky-500', ky: '500', J: '101' })], ex);
    expect(p.tierF[0]).toMatchObject({ v: 'ky', n: '500', J: '101' });
  });
  it('routes a both-vendor tj-slug row to Tier E', () => {
    const p = buildPlan([row({ song_id: 'tj-500', tj: '500', ky: '600', J: '102' })], ex);
    expect(p.tierE[0]).toMatchObject({ v: 'tj', n: '500', J: '102' });
    expect(p.tierF).toHaveLength(0);
  });
  // #165 removed the reviewed-tier tj-slug/singleton guard, so a Tier E
  // [tj, joysound] pair fires by the tj vendor-number cell regardless of the
  // affected row's id-slug. A both-vendor (tj+ky) row therefore encodes to Tier
  // E via its tj number even under a ky-/tjpdf-/blog- id-slug.
  it.each(['ky-500', 'tjpdf-500', 'blog-500-3'])(
    'routes a both-vendor row with a non-tj id (%s) to Tier E via its tj number',
    (songId) => {
      const p = buildPlan([row({ song_id: songId, tj: '500', ky: '600', J: '103' })], ex);
      expect(p.tierE[0]).toMatchObject({ v: 'tj', n: '500', J: '103' });
      expect(p.tierF).toHaveLength(0);
      expect(p.unencodable['both-vendor-non-tj-id']).toBeUndefined();
    },
  );
  it('classifies a both-vendor non-tj row whose joysound is already owned as both-vendor-number', () => {
    const p = buildPlan([row({ song_id: 'ky-500', tj: '500', ky: '600', J: '888888' })], ex);
    expect(p.unencodable['both-vendor-number']).toHaveLength(1);
    expect(p.tierE.length + p.tierF.length).toBe(0);
  });
});

describe('buildPlan guards', () => {
  const ex = parseReviewedSource(SAMPLE_SOURCE);
  it('never encodes a pair present in a forbidden set', () => {
    const p = buildPlan([row({ song_id: 'tj-6927', tj: '6927', J: '19868' })], ex);
    expect(p.unencodable.forbidden).toHaveLength(1);
    expect(p.tierF).toHaveLength(0);
  });
  it('skips an already-encoded exact pair', () => {
    const p = buildPlan([row({ song_id: 'ky-44158', ky: '44158', J: '689337' })], ex);
    expect(p.unencodable['already-encoded']).toHaveLength(1);
  });
  it('classifies a SAME-vendor ky reuse of a ky-owned joysound as 3way-existing-reviewed', () => {
    // Owner and candidate share a vendor (ky↔ky owner) → a genuine duplicate,
    // NOT a 3-way bridge; it stays unencodable in 3way-existing-reviewed.
    const p = buildPlan([row({ song_id: 'ky-700', ky: '700', J: '689337' })], ex);
    expect(p.unencodable['3way-existing-reviewed']).toHaveLength(1);
    expect(p.unencodable['3way-existing-reviewed'][0].existingOwner).toBe('tierF ky:44158');
    expect(p.tierF3wayAttach).toHaveLength(0);
  });
  it('classifies a tj row whose joysound is owned by another tj-pair as both-vendor-number', () => {
    const p = buildPlan([row({ song_id: 'tj-700', tj: '700', J: '888888' })], ex);
    expect(p.unencodable['both-vendor-number']).toHaveLength(1);
  });
  it('keeps the tj side and drops the ky side of an in-batch 3-way (unique-joysound)', () => {
    const p = buildPlan(
      [
        row({ song_id: 'ky-800', ky: '800', J: '200' }),
        row({ song_id: 'tj-801', tj: '801', J: '200' }),
      ],
      ex,
    );
    expect(p.tierF).toHaveLength(1);
    expect(p.tierF[0]).toMatchObject({ v: 'tj', n: '801', J: '200' });
    expect(p.unencodable['3way-dupJ']).toHaveLength(1);
    expect(p.unencodable['3way-dupJ'][0].song_id).toBe('ky-800');
    expect(p.unencodable['3way-dupJ'][0].winner).toBe('tj-801');
  });
});

describe('buildPlan 3-way attach derivation (option B2)', () => {
  const ex = parseReviewedSource(SAMPLE_SOURCE);
  it('derives a ky bridge when a tj pair owns the joysound (owner tj → attach ky)', () => {
    const p = buildPlan([row({ song_id: 'ky-700', ky: '700', J: '999999' })], ex);
    expect(p.tierF3wayAttach).toHaveLength(1);
    expect(p.tierF3wayAttach[0]).toMatchObject({ v: 'ky', n: '700', J: '999999' });
    expect(p.tierF3wayAttach[0].existingOwner).toBe('tierE tj-25065');
    expect(p.unencodable['3way-existing-reviewed']).toHaveLength(0);
  });
  it('derives a tj bridge when a ky pair owns the joysound (owner ky → attach tj, vendor-symmetric)', () => {
    // The first tj-onto-ky-owned attach. Confirms the derivation is vendor
    // symmetric, not hard-coded to "owner is tj".
    const p = buildPlan([row({ song_id: 'tj-700', tj: '700', J: '689337' })], ex);
    expect(p.tierF3wayAttach).toHaveLength(1);
    expect(p.tierF3wayAttach[0]).toMatchObject({ v: 'tj', n: '700', J: '689337' });
    expect(p.tierF3wayAttach[0].existingOwner).toBe('tierF ky:44158');
    expect(p.unencodable['both-vendor-number']).toHaveLength(0);
  });
  it('does NOT emit when the attach target cell collides with an existing reviewed target', () => {
    // ky:44158 is already a Tier F target (owns 689337); reusing that cell for a
    // different joysound would double-map it, so the attach is refused.
    const p = buildPlan([row({ song_id: 'ky-44158', ky: '44158', J: '999999' })], ex);
    expect(p.tierF3wayAttach).toHaveLength(0);
    expect(p.unencodable['target-conflict-existing']).toHaveLength(1);
  });
  it('reports an already-committed attach as already-encoded (idempotent)', () => {
    const p = buildPlan([row({ song_id: 'ky-40141', ky: '40141', J: '888888' })], ex);
    expect(p.tierF3wayAttach).toHaveLength(0);
    expect(p.unencodable['already-encoded']).toHaveLength(1);
    expect(p.unencodable['already-encoded'][0].attach).toBe(true);
  });
  it('formats an attach code line with the owner annotation', () => {
    const p = buildPlan([row({ song_id: 'ky-700', ky: '700', J: '999999' })], ex);
    const { tierF3wayAttach } = entryLines(p);
    expect(tierF3wayAttach[0]).toBe(
      "  ['ky', '700', '999999'], // ky-700 T / A ↔ T2 / A2 [owner tierE tj-25065]",
    );
  });
});

describe('entryLines', () => {
  const ex = parseReviewedSource(SAMPLE_SOURCE);
  it('formats Tier E and Tier F code lines with a provenance comment', () => {
    const p = buildPlan(
      [
        row({ song_id: 'tj-500', tj: '500', ky: '600', J: '102', title: 'S', candTitle: 'S2' }),
        row({ song_id: 'ky-900', ky: '900', J: '300' }),
      ],
      ex,
    );
    const { tierE, tierF } = entryLines(p);
    expect(tierE[0]).toBe("  ['500', '102'], // tj-500 S / A ↔ S2 / A2");
    expect(tierF[0]).toBe("  ['ky', '900', '300'], // ky-900 T / A ↔ T2 / A2");
  });
});

describe('loadReviews later-file-wins dedup', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'encode-b-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (name, obj) => writeFileSync(join(dir, name), JSON.stringify(obj));

  it('a later verdict file overrides an earlier verdict for the same song_id (uncertain → merge)', () => {
    write('batch-A-1.json', [
      {
        song: { id: 'tj-100', title: 'T', artist: 'A', tj: '100', ky: null },
        candidates: [{ id: 'joysound-9', joysound: '900', title: 'Tc', artist: 'Ac' }],
      },
    ]);
    write('verdicts-A-1.json', [{ song_id: 'tj-100', verdict: 'uncertain', reason: 'ambiguous' }]);
    write('verdicts-D-1.json', [
      {
        song_id: 'tj-100',
        verdict: 'merge',
        candidate_id: 'joysound-9',
        candidate_joysound: '900',
        reason: 'owner confirmed',
      },
    ]);

    const { merges, uncertain, counts, overrides } = loadReviews(dir);
    // The D-1 merge supersedes the A-1 uncertain: one merge, zero uncertain.
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ song_id: 'tj-100', J: '900', candTitle: 'Tc' });
    expect(uncertain).toHaveLength(0);
    expect(counts).toMatchObject({ merge: 1, uncertain: 0 });
    // The override is recorded, not applied silently.
    expect(overrides).toEqual([
      {
        song_id: 'tj-100',
        from: { verdict: 'uncertain', file: 'verdicts-A-1.json' },
        to: { verdict: 'merge', file: 'verdicts-D-1.json' },
      },
    ]);
  });

  it('records no override when each song_id is decided exactly once', () => {
    write('batch-A-1.json', [
      { song: { id: 'tj-1', title: 'X', artist: 'A', tj: '1', ky: null }, candidates: [] },
    ]);
    write('verdicts-A-1.json', [{ song_id: 'tj-1', verdict: 'reject', reason: 'no' }]);

    const { overrides, counts, merges, uncertain } = loadReviews(dir);
    expect(overrides).toHaveLength(0);
    expect(counts).toMatchObject({ merge: 0, reject: 1, uncertain: 0 });
    expect(merges).toHaveLength(0);
    expect(uncertain).toHaveLength(0);
  });
});

describe('forbidden release path', () => {
  const stillForbidden = parseReviewedSource(SAMPLE_SOURCE);
  // Simulate the owner adjudication removing the pair from the forbidden set.
  const released = parseReviewedSource(
    SAMPLE_SOURCE.replace("  ['tj', '6927', '19868'], // artist 19\n", ''),
  );

  it('leaves the pair unencodable while it is in the forbidden set', () => {
    const p = buildPlan([row({ song_id: 'tj-6927', tj: '6927', J: '19868' })], stillForbidden);
    expect(p.unencodable.forbidden).toHaveLength(1);
    expect(p.tierE.length + p.tierF.length).toBe(0);
  });

  it('encodes the same pair once it is removed from the forbidden set', () => {
    const p = buildPlan([row({ song_id: 'tj-6927', tj: '6927', J: '19868' })], released);
    expect(p.unencodable.forbidden).toHaveLength(0);
    expect(p.tierF).toHaveLength(1);
    expect(p.tierF[0]).toMatchObject({ v: 'tj', n: '6927', J: '19868' });
  });
});

// Integration against the committed verdicts + tables. Locks the reproducible
// numbers the 2026-07-20 B2 PR is built on: the encoder derives EXACTLY 85
// attach entries from an empty attach table (83 ky rows + ky-41123 + tj-26145),
// and is idempotent against the populated table. Any table/verdict drift trips
// this loudly.
describe('encode-b integration (committed data)', () => {
  const realSource = readFileSync(REAL_SOURCE, 'utf8');
  const { merges, overrides } = loadReviews(REAL_REVIEWS);

  it('loads 483 merge verdicts including the two B2 supplementals', () => {
    expect(merges).toHaveLength(483);
    expect(merges.find((m) => m.song_id === 'ky-41123')).toMatchObject({ J: '11509' });
    expect(merges.find((m) => m.song_id === 'tj-26145')).toMatchObject({ J: '1546' });
    // tj-26145's B-wave reject was overridden by the D-2 supplemental merge.
    expect(overrides.find((o) => o.song_id === 'tj-26145')).toMatchObject({
      from: { verdict: 'reject' },
      to: { verdict: 'merge' },
    });
  });

  it('derives exactly 85 attach entries from an empty attach table (83 + 2 supplementals)', () => {
    const preEncode = realSource.replace(
      /const REVIEWED_TIER_F_3WAY_ATTACH_PAIRS = \[[\s\S]*?\] as const/,
      'const REVIEWED_TIER_F_3WAY_ATTACH_PAIRS = [] as const',
    );
    const p = buildPlan(merges, parseReviewedSource(preEncode));
    expect(p.tierF3wayAttach).toHaveLength(85);
    expect(p.unencodable['3way-existing-reviewed']).toHaveLength(0);
    expect(p.unencodable['both-vendor-number']).toHaveLength(1); // tj-26737 (tj↔tj-owned)
    // 84 ky bridges + the single tj-26145 (vendor-symmetric, ky-owned joysound).
    expect(p.tierF3wayAttach.filter((e) => e.v === 'ky')).toHaveLength(84);
    expect(p.tierF3wayAttach.filter((e) => e.v === 'tj')).toHaveLength(1);
    expect(p.tierF3wayAttach.find((e) => e.v === 'tj')).toMatchObject({ n: '26145', J: '1546' });
  });

  it('is idempotent against the committed (populated) attach table', () => {
    const p = buildPlan(merges, parseReviewedSource(realSource));
    expect(p.tierF3wayAttach).toHaveLength(0);
    expect(p.unencodable['3way-existing-reviewed']).toHaveLength(0);
    expect(p.unencodable['already-encoded'].filter((e) => e.attach)).toHaveLength(85);
  });
});
