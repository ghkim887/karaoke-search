import { describe, expect, it } from 'vitest';
import { applyStrip, parseArgs } from './apply-ky-tieup-strip.mjs';

// A stand-in stripper (the real one is the crawler's normalizeKyTitle, imported
// from dist at runtime); here we inject a fake so the transform logic is tested
// without the built dist.
const fakeStrip = (t) => (t.endsWith('(錯乱 OST)') ? t.replace('(錯乱 OST)', '') : t);

describe('applyStrip', () => {
  it('strips ky-* titles and counts the changes', () => {
    const records = [
      { id: 'ky-1', title_primary: 'この世の限り(錯乱 OST)', karaoke_numbers: { ky: '1' } },
      { id: 'ky-2', title_primary: '怪物', karaoke_numbers: { ky: '2' } },
    ];
    const { records: out, changed } = applyStrip(records, fakeStrip);
    expect(changed).toBe(1);
    expect(out[0].title_primary).toBe('この世の限り');
    expect(out[1].title_primary).toBe('怪物'); // unchanged
    // Non-mutating on unchanged rows (same reference preserved).
    expect(out[1]).toBe(records[1]);
  });

  it('leaves non-ky records untouched', () => {
    const records = [{ id: 'tj-9', title_primary: 'x(錯乱 OST)', karaoke_numbers: { tj: '9' } }];
    const { records: out, changed } = applyStrip(records, fakeStrip);
    expect(changed).toBe(0);
    expect(out[0]).toBe(records[0]);
  });
});

describe('parseArgs', () => {
  it('parses --in/--out', () => {
    expect(parseArgs(['--in', 'a', '--out', 'b'])).toEqual({ in: 'a', out: 'b', help: false });
  });
  it('throws on unknown flags and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--in'])).toThrow(/requires a path/);
  });
});
