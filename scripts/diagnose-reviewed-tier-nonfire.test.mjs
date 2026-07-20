import { describe, expect, it } from 'vitest';
import { classify, parseArgs, reviewedPairs } from './diagnose-reviewed-tier-nonfire.mjs';

describe('parseArgs', () => {
  it('parses corpus/out/samples', () => {
    const a = parseArgs(['--corpus', 'c.json', '--out', 'o.json', '--samples', '3']);
    expect(a).toMatchObject({ corpus: 'c.json', out: 'o.json', samples: 3 });
  });
  it('requires corpus and out', () => {
    expect(() => parseArgs(['--corpus', 'c.json'])).toThrow(/required/);
  });
});

describe('reviewedPairs', () => {
  it('flattens both tier tables into pair rows', () => {
    const deps = {
      REVIEWED_TIER_E_JOYS_BY_TJ: new Map([['100', new Set(['900'])]]),
      REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER: new Map([['ky:40138', new Set(['2238'])]]),
    };
    expect(reviewedPairs(deps)).toEqual([
      { tier: 'E', vendor: 'tj', number: '100', joysound: '900' },
      { tier: 'F', vendor: 'ky', number: '40138', joysound: '2238' },
    ]);
  });
});

const kn = (o) => ({ tj: null, ky: null, joysound: null, ...o });

describe('classify — un-fired cause buckets', () => {
  it('fired: target and joysound in one record', () => {
    const merged = [{ id: 'ky-1', karaoke_numbers: kn({ ky: '1', joysound: '9' }) }];
    const raw = new Map();
    const { counts } = classify(
      [{ tier: 'F', vendor: 'ky', number: '1', joysound: '9' }],
      merged,
      raw,
      5,
    );
    expect(counts.fired).toBe(1);
  });

  it('joy-merged-into-cluster: raw joy was joy-only but merged into a multi-vendor record', () => {
    const joyRec = { id: 'tj-twin', karaoke_numbers: kn({ tj: '77', joysound: '9' }) };
    const targetRec = { id: 'ky-1', karaoke_numbers: kn({ ky: '1' }) };
    const raw = new Map([['9', { id: 'joysound-9', karaoke_numbers: kn({ joysound: '9' }) }]]);
    const { counts } = classify(
      [{ tier: 'F', vendor: 'ky', number: '1', joysound: '9' }],
      [joyRec, targetRec],
      raw,
      5,
    );
    expect(counts['joy-merged-into-cluster']).toBe(1);
  });

  it('joy-native-multivendor: raw joy row already carried another vendor number', () => {
    const joyRec = { id: 'joysound-9', karaoke_numbers: kn({ tj: '77', joysound: '9' }) };
    const targetRec = { id: 'ky-1', karaoke_numbers: kn({ ky: '1' }) };
    const raw = new Map([
      ['9', { id: 'joysound-9', karaoke_numbers: kn({ tj: '77', joysound: '9' }) }],
    ]);
    const { counts } = classify(
      [{ tier: 'F', vendor: 'ky', number: '1', joysound: '9' }],
      [joyRec, targetRec],
      raw,
      5,
    );
    expect(counts['joy-native-multivendor']).toBe(1);
  });

  it('joy-merged-into-cluster: joysound↔joysound absorption (no extra tj/ky, different survivor id)', () => {
    // The joysound-9 row was auto-merged with joysound-99; the survivor id is
    // joysound-99 while the pair still targets joysound 9. No tj/ky cell to spot.
    const joyRec = { id: 'joysound-99', karaoke_numbers: kn({ joysound: '9' }) };
    const targetRec = { id: 'ky-1', karaoke_numbers: kn({ ky: '1' }) };
    const raw = new Map([['9', { id: 'joysound-9', karaoke_numbers: kn({ joysound: '9' }) }]]);
    const { counts } = classify(
      [{ tier: 'F', vendor: 'ky', number: '1', joysound: '9' }],
      [joyRec, targetRec],
      raw,
      5,
    );
    expect(counts['joy-merged-into-cluster']).toBe(1);
    expect(counts['both-single-unfired']).toBe(0);
  });

  it('both-single-unfired: both clean singletons yet not unioned (real bug signal)', () => {
    const joyRec = { id: 'joysound-9', karaoke_numbers: kn({ joysound: '9' }) };
    const targetRec = { id: 'ky-1', karaoke_numbers: kn({ ky: '1' }) };
    const raw = new Map([['9', { id: 'joysound-9', karaoke_numbers: kn({ joysound: '9' }) }]]);
    const { counts } = classify(
      [{ tier: 'F', vendor: 'ky', number: '1', joysound: '9' }],
      [joyRec, targetRec],
      raw,
      5,
    );
    expect(counts['both-single-unfired']).toBe(1);
  });

  it('joy-absent when no record carries the joysound number', () => {
    const { counts } = classify(
      [{ tier: 'F', vendor: 'ky', number: '1', joysound: '9' }],
      [{ id: 'ky-1', karaoke_numbers: kn({ ky: '1' }) }],
      new Map(),
      5,
    );
    expect(counts['joy-absent']).toBe(1);
  });
});
