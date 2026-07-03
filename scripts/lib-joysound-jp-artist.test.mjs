// Tests for scripts/lib/joysound-jp-artist.mjs — the known-Japanese-artist
// predicate shared by the JOYSOUND detail sweep, the listing diagnostic sweep,
// and the offline replay classifier. The predicate build imports the built
// crawler dist (clustering + drop lists), like the sweep integration tests.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GENERIC_ARTIST_KEYS,
  buildKnownJapaneseArtistPredicate,
} from './lib/joysound-jp-artist.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-jp-artist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function corpusFile(records) {
  const p = join(dir, 'corpus.json');
  writeFileSync(p, JSON.stringify(records), 'utf8');
  return p;
}

describe('GENERIC_ARTIST_KEYS', () => {
  it('contains the generic bucket names that must not seed the JP set', () => {
    for (const key of ['variousartists', 'various', 'unknown', 'オムニバス']) {
      expect(GENERIC_ARTIST_KEYS.has(key)).toBe(true);
    }
  });
});

describe('buildKnownJapaneseArtistPredicate', () => {
  it('returns undefined when no corpus path is supplied (recall path stays off)', async () => {
    expect(await buildKnownJapaneseArtistPredicate(undefined)).toBeUndefined();
  });

  it('admits a corpus Japanese artist and excludes generic buckets', async () => {
    const pred = await buildKnownJapaneseArtistPredicate(
      corpusFile([
        { artist_primary: 'YOASOBI' },
        { artist_primary: '米津玄師' },
        { artist_primary: 'Various Artists' },
      ]),
      { label: 'test' },
    );
    expect(typeof pred).toBe('function');
    expect(pred('YOASOBI')).toBe(true);
    expect(pred('米津玄師')).toBe(true);
    // Generic bucket name is excluded from the set.
    expect(pred('Various Artists')).toBe(false);
    // An artist absent from the corpus is not known-Japanese.
    expect(pred('Nonexistent Act')).toBe(false);
  });

  it('throws with the supplied label when the corpus is not a JSON array', async () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({ not: 'an array' }), 'utf8');
    await expect(buildKnownJapaneseArtistPredicate(p, { label: 'joysound-diagnostic' })).rejects.toThrow(
      /\[joysound-diagnostic\] corpus .* is not a JSON array/,
    );
  });
});
