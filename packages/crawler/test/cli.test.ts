import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('skips a literal -- separator (pnpm pass-through convention)', () => {
    const parsed = parseArgs(['--', '--limit', '5', '--out', 'x.json']);
    expect(parsed.limit).toBe(5);
    expect(parsed.out).toBe('x.json');
    expect(parsed.help).toBe(false);
    expect(parsed.sources).toEqual([]);
  });

  it('still rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });

  it('parses --limit, --out, and --source without a separator', () => {
    const parsed = parseArgs([
      '--limit',
      '3',
      '--out',
      'y.json',
      '--source',
      'a,b',
      '--source',
      'c',
    ]);
    expect(parsed.limit).toBe(3);
    expect(parsed.out).toBe('y.json');
    expect(parsed.sources).toEqual(['a', 'b', 'c']);
  });
});
