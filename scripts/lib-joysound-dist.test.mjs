// Tests for scripts/lib/joysound-dist.mjs — the built-crawler-dist loaders
// shared by the JOYSOUND scripts. These are integration tests against the built
// `packages/crawler/dist`, like joysound-detail-sweep.test.mjs; they require
// `corepack pnpm --filter @karaoke/crawler build` to have run (CI does this).

import { describe, expect, it } from 'vitest';
import {
  loadJoysoundClassifier,
  loadJoysoundDetailParser,
  loadJpArtistDropDeps,
} from './lib/joysound-dist.mjs';

describe('loadJoysoundClassifier', () => {
  it('resolves the built classifier module exposing buildJoysoundDecision', async () => {
    const mod = await loadJoysoundClassifier('test');
    expect(typeof mod.buildJoysoundDecision).toBe('function');
  });
});

describe('loadJoysoundDetailParser', () => {
  it('resolves the detail parser module exposing parseJoysoundDetail', async () => {
    const mod = await loadJoysoundDetailParser();
    expect(typeof mod.parseJoysoundDetail).toBe('function');
  });
});

describe('loadJpArtistDropDeps', () => {
  it('resolves clustering + drop-list helpers', async () => {
    const deps = await loadJpArtistDropDeps();
    expect(typeof deps.normalizeForMatch).toBe('function');
    expect(typeof deps.splitArtistCollab).toBe('function');
    expect(typeof deps.isInDropList).toBe('function');
    expect(typeof deps.isInChineseDropList).toBe('function');
  });
});
