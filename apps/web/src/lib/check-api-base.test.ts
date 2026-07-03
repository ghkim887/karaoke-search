import { describe, expect, it } from 'vitest';
import { findCorruptionSignatures } from '../../scripts/check-api-base';

describe('findCorruptionSignatures (postbuild corruption scan)', () => {
  it('flags the actual incident signature baked into a JS chunk', () => {
    expect(findCorruptionSignatures('function ts(){return Xn("C:/Program Files/Git/")}')).toEqual([
      'C:/Program Files',
    ]);
  });

  it('flags the backslash and escaped-backslash Windows path variants', () => {
    // Single backslash (runtime string value).
    expect(findCorruptionSignatures('const b="C:\\Program Files\\Git";').length).toBeGreaterThan(0);
    // Double backslash (how a JS string literal is stored in the bundle bytes).
    expect(
      findCorruptionSignatures('const b="C:\\\\Program Files\\\\Git";').length,
    ).toBeGreaterThan(0);
  });

  it('flags other real mangled roots (Users / Windows) and file:// URLs', () => {
    expect(findCorruptionSignatures('"C:/Users/kmend/AppData/Local/Programs/Git"').length).toBe(1);
    expect(findCorruptionSignatures('"C:/Windows/system32"').length).toBe(1);
    expect(findCorruptionSignatures('fetch("file:///C:/Program Files/Git/api/meta")').length).toBe(
      2,
    );
  });

  it('does NOT flag minified-JS shapes (identifier + colon + regex literal)', () => {
    expect(findCorruptionSignatures('const o={t:/[a-z]+/};')).toEqual([]);
    expect(findCorruptionSignatures('return a?b:/x/;')).toEqual([]);
    expect(findCorruptionSignatures('const o={a:1,z:/\\d/};')).toEqual([]);
  });

  it('does NOT flag a clean same-origin / absolute base', () => {
    expect(findCorruptionSignatures('function ts(){return Xn("/")}')).toEqual([]);
    expect(findCorruptionSignatures('function ts(){return Xn("https://api.example.com")}')).toEqual(
      [],
    );
  });
});
