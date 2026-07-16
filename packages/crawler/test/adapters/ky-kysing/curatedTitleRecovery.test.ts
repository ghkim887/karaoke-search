import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lookupKyTitleRecovery } from '../../../src/adapters/ky-kysing/curatedTitleRecovery.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MAP_PATH = resolve(HERE, '../../../src/adapters/ky-kysing/curated-title-recovery.json');
const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as Record<
  string,
  { title: string; artist: string; source: string }
>;

describe('curated-title-recovery.json — data integrity', () => {
  it('has entries', () => {
    expect(Object.keys(map).length).toBeGreaterThan(2000);
  });

  it('every key is a bare-digit KY number', () => {
    for (const ky of Object.keys(map)) {
      expect(ky).toMatch(/^[0-9]+$/);
    }
  });

  it('every value has a non-empty title/artist with no truncation sentinel and a source', () => {
    for (const [ky, entry] of Object.entries(map)) {
      expect(entry.title, `title for ${ky}`).toBeTruthy();
      expect(entry.artist, `artist for ${ky}`).toBeTruthy();
      expect(entry.title.endsWith('..'), `title '..' for ${ky}`).toBe(false);
      expect(entry.artist.endsWith('..'), `artist '..' for ${ky}`).toBe(false);
      expect(typeof entry.source).toBe('string');
      expect(entry.source.length).toBeGreaterThan(0);
    }
  });

  it('keys are numerically sorted (stable diffs)', () => {
    const keys = Object.keys(map).map(Number);
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i]).toBeGreaterThan(keys[i - 1] as number);
    }
  });
});

describe('lookupKyTitleRecovery', () => {
  it('returns the manual entry for ky 44092', () => {
    expect(lookupKyTitleRecovery('44092')).toEqual({
      title: 'Connecting',
      artist: 'halyosy feat.初音ミク、鏡音リン・レン、巡音ルカ、KAITO、MEIKO',
      source: 'manual-20260716',
    });
  });

  it('returns an anisong-book entry (76519 Burning / 羊文学)', () => {
    expect(lookupKyTitleRecovery('76519')).toEqual({
      title: 'Burning',
      artist: '羊文学',
      source: 'anisong-book-42',
    });
  });

  it('returns null for a number not in the map', () => {
    expect(lookupKyTitleRecovery('99999999')).toBeNull();
  });
});
