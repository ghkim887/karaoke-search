import { describe, expect, it } from 'vitest';
import { normalize } from './normalize.js';

describe('normalize (web mirror of crawler normalize)', () => {
  // The 7 worked examples pinned when the normalizer was designed.
  // Parity with packages/crawler/src/normalize.ts is required.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['DECO*27', 'deco27'],
    ['ヨルシカ', 'ヨルシカ'],
    ['米津玄師', '米津玄師'],
    ['YOASOBI', 'yoasobi'],
    ['imase', 'imase'],
    ['花に亡霊 (movie ver.)', '花に亡霊moviever'],
    ['Mrs. GREEN APPLE', 'mrsgreenapple'],
  ];

  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalize(input)).toBe(expected);
    });
  }
});
