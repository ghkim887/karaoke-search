import { describe, expect, it } from 'vitest';
import { applyCategoryExclusivity } from '../src/index.js';

describe('applyCategoryExclusivity — priority vocaloid > anime > jpop', () => {
  function asSet(cats: ('jpop' | 'vocaloid' | 'anime')[]): Set<'jpop' | 'vocaloid' | 'anime'> {
    return new Set(cats);
  }
  function asSorted(s: Set<'jpop' | 'vocaloid' | 'anime'>): string[] {
    return [...s].sort();
  }

  it('leaves [jpop] unchanged', () => {
    const s = asSet(['jpop']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['jpop']);
  });

  it('leaves [anime] unchanged', () => {
    const s = asSet(['anime']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['anime']);
  });

  it('leaves [vocaloid] unchanged', () => {
    const s = asSet(['vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });

  it('drops jpop from [jpop, anime] -> [anime]', () => {
    const s = asSet(['jpop', 'anime']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['anime']);
  });

  it('drops jpop from [jpop, vocaloid] -> [vocaloid]', () => {
    const s = asSet(['jpop', 'vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });

  it('drops anime from [anime, vocaloid] -> [vocaloid] (vocaloid wins)', () => {
    const s = asSet(['anime', 'vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });

  it('collapses [jpop, anime, vocaloid] -> [vocaloid]', () => {
    const s = asSet(['jpop', 'anime', 'vocaloid']);
    applyCategoryExclusivity(s);
    expect(asSorted(s)).toEqual(['vocaloid']);
  });
});
