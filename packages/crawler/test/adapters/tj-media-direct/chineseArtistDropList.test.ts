import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHINESE_ARTIST_DROP_LIST,
  CHINESE_DROP_KEY_SET,
  CHINESE_DROP_LIST,
  isInChineseDropList,
} from '../../../src/adapters/tj-media-direct/chineseArtistDropList.js';
import { normalizeForMatch } from '../../../src/adapters/tj-media-direct/normalize.js';

// ---------------------------------------------------------------------------
// Structured-entry shape tests (parity with koreanArtistDropList.test.ts)
// ---------------------------------------------------------------------------

describe('chineseArtistDropList — structured DropListEntry schema', () => {
  it('exports at least 9 canonical entries (one per distinct Cantopop/Mandopop act)', () => {
    expect(CHINESE_DROP_LIST.length).toBeGreaterThanOrEqual(9);
  });

  it('every entry has the required fields: canonical, variants, lastReviewed', () => {
    for (const entry of CHINESE_DROP_LIST) {
      expect(typeof entry.canonical).toBe('string');
      expect(entry.canonical.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.variants)).toBe(true);
      expect(entry.variants.length).toBeGreaterThan(0);
      expect(typeof entry.lastReviewed).toBe('string');
    }
  });

  it('every entry has a `lastReviewed` ISO date (YYYY-MM-DD)', () => {
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    for (const entry of CHINESE_DROP_LIST) {
      expect(
        isoDate.test(entry.lastReviewed),
        `entry ${entry.canonical} has malformed lastReviewed: ${entry.lastReviewed}`,
      ).toBe(true);
      const parsed = Date.parse(entry.lastReviewed);
      expect(Number.isFinite(parsed)).toBe(true);
    }
  });

  it('every variant in every entry normalizes to a non-empty key', () => {
    for (const entry of CHINESE_DROP_LIST) {
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        expect(
          key,
          `variant "${variant}" in entry "${entry.canonical}" normalizes to empty string`,
        ).not.toBe('');
      }
    }
  });

  it('CHINESE_DROP_KEY_SET contains the normalized form of every variant', () => {
    for (const entry of CHINESE_DROP_LIST) {
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        expect(
          CHINESE_DROP_KEY_SET.has(key),
          `variant "${variant}" (key="${key}") from entry "${entry.canonical}" missing from CHINESE_DROP_KEY_SET`,
        ).toBe(true);
      }
    }
  });

  it('CHINESE_DROP_KEY_SET has one entry per distinct normalized variant key (no cross-canonical collisions)', () => {
    // Within-entry collisions are expected (BEYOND/Beyond/beyond all → "beyond").
    // Cross-entry collisions (two distinct canonicals sharing a key) are data errors.
    const keyToCanonicals = new Map<string, Set<string>>();
    const keyToEntryStrings = new Map<string, string[]>();
    for (const entry of CHINESE_DROP_LIST) {
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        let canonSet = keyToCanonicals.get(key);
        if (!canonSet) {
          canonSet = new Set<string>();
          keyToCanonicals.set(key, canonSet);
        }
        canonSet.add(entry.canonical);
        const arr = keyToEntryStrings.get(key);
        if (arr) arr.push(`${entry.canonical}/${variant}`);
        else keyToEntryStrings.set(key, [`${entry.canonical}/${variant}`]);
      }
    }
    const collisions: string[] = [];
    for (const [key, canonSet] of keyToCanonicals) {
      if (canonSet.size > 1) {
        collisions.push(`  - "${key}": [${keyToEntryStrings.get(key)?.join(', ')}]`);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `Drop-list cross-canonical variant collisions detected — each normalized key must come from ONE canonical entry:\n${collisions.join('\n')}`,
      );
    }
    expect(CHINESE_DROP_KEY_SET.size).toBe(keyToCanonicals.size);
  });

  it('non-blocking warning for entries older than 90 days (3-month review cadence)', () => {
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const stale: string[] = [];
    for (const entry of CHINESE_DROP_LIST) {
      const reviewedMs = Date.parse(entry.lastReviewed);
      if (!Number.isFinite(reviewedMs)) continue;
      if (nowMs - reviewedMs > NINETY_DAYS_MS) {
        const ageDays = Math.floor((nowMs - reviewedMs) / (24 * 60 * 60 * 1000));
        stale.push(`${entry.canonical} (lastReviewed=${entry.lastReviewed}, ${ageDays}d ago)`);
      }
    }
    if (stale.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[chineseArtistDropList] ${stale.length} entries are older than 90 days — re-probe against tj-search-cache.json and bump lastReviewed:\n  ${stale.join('\n  ')}`,
      );
    }
    // Soft warning, not a hard failure. Same policy as koreanArtistDropList.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Original surface-form coverage tests (preserved from flat-schema version)
// ---------------------------------------------------------------------------

describe('chineseArtistDropList — Cantopop / Mandopop seed list', () => {
  // Every observed surface form from the 2026-05-06 audit. Three of these
  // (BEYOND, Twins) appeared in multiple cases on different records, hence
  // the explicit case-sensitive variants — they all collapse to the same
  // pre-normalized key, but the raw list documents what was observed.
  const ALL_VARIANTS: readonly string[] = [
    'BEYOND',
    'Beyond',
    'beyond',
    'F4',
    'S.H.E',
    'Twins',
    'twins',
    'TWINS',
    'R1SE',
    'B.A.D',
    'F.I.R.',
    'Marry-M',
    'NZBZ',
  ];

  it('exports a Set covering every observed surface form (post-normalize)', () => {
    for (const variant of ALL_VARIANTS) {
      const key = normalizeForMatch(variant);
      expect(
        CHINESE_ARTIST_DROP_LIST.has(key),
        `variant ${variant} (key=${key}) should be in the set`,
      ).toBe(true);
    }
  });

  it('case variants collapse to the same normalized key (BEYOND family)', () => {
    expect(normalizeForMatch('BEYOND')).toBe(normalizeForMatch('Beyond'));
    expect(normalizeForMatch('BEYOND')).toBe(normalizeForMatch('beyond'));
    expect(CHINESE_ARTIST_DROP_LIST.has(normalizeForMatch('BEYOND'))).toBe(true);
  });

  it('case variants collapse to the same normalized key (Twins family)', () => {
    expect(normalizeForMatch('Twins')).toBe(normalizeForMatch('twins'));
    expect(normalizeForMatch('Twins')).toBe(normalizeForMatch('TWINS'));
    expect(CHINESE_ARTIST_DROP_LIST.has(normalizeForMatch('Twins'))).toBe(true);
  });
});

describe('isInChineseDropList — exact-match (post-normalize) semantics', () => {
  it('returns true for the canonical pre-normalized key (BEYOND)', () => {
    expect(isInChineseDropList(normalizeForMatch('BEYOND'))).toBe(true);
  });

  it('case-insensitive via the normalize step (`Beyond`, `beyond` both match)', () => {
    expect(isInChineseDropList(normalizeForMatch('Beyond'))).toBe(true);
    expect(isInChineseDropList(normalizeForMatch('beyond'))).toBe(true);
  });

  it('whitespace-collapse via the normalize step (`  beyond  ` matches)', () => {
    // Smoke-test that the parser hot-path normalization (which collapses
    // whitespace) reduces to the same key. Direct un-normalized lookup is
    // out of scope — the parser always normalizes before calling.
    expect(isInChineseDropList(normalizeForMatch('  beyond  '))).toBe(true);
  });

  it('returns false on the empty string (defensive)', () => {
    expect(isInChineseDropList('')).toBe(false);
  });

  it('returns false for a real Japanese act with similar surface form', () => {
    // Sanity: 米津玄師 must NOT match — drop list is for Chinese acts only.
    expect(isInChineseDropList(normalizeForMatch('米津玄師'))).toBe(false);
    // YOASOBI must NOT match.
    expect(isInChineseDropList(normalizeForMatch('YOASOBI'))).toBe(false);
  });

  it('returns false for an unrelated string with no overlap', () => {
    expect(isInChineseDropList(normalizeForMatch('not on the list'))).toBe(false);
  });
});

describe('chineseArtistDropList — sidecar JSON staleness check', () => {
  // The sidecar at `packages/crawler/src/adapters/tj-media-direct/
  // chinese-artist-drop-list.json` is the source-of-truth for the Python
  // consumer (`scripts/drop_cpop_leaks.py`). It is regenerated by
  // `scripts/export-chinese-drop-list.mjs` (which the crawler's `build`
  // script invokes after `tsc -b`). Tracking the file in git makes a
  // forgotten regen visible at code-review time — this test makes the same
  // mismatch visible at test time too.
  //
  // If this test fails, run `corepack pnpm --filter @karaoke/crawler build`
  // (or `node scripts/export-chinese-drop-list.mjs` directly after a
  // previous build) to regenerate the sidecar.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SIDECAR_PATH = resolve(
    HERE,
    '../../../src/adapters/tj-media-direct/chinese-artist-drop-list.json',
  );

  interface SidecarShape {
    version: number;
    keys: string[];
  }

  it('sidecar JSON file exists at the tracked src/ path', () => {
    expect(() => readFileSync(SIDECAR_PATH, 'utf-8')).not.toThrow();
  });

  it('sidecar `keys.length` matches CHINESE_ARTIST_DROP_LIST.size (regen check)', () => {
    const raw = readFileSync(SIDECAR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SidecarShape;
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.keys.length).toBe(CHINESE_ARTIST_DROP_LIST.size);
  });

  it('sidecar contains every CHINESE_ARTIST_DROP_LIST entry', () => {
    const raw = readFileSync(SIDECAR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SidecarShape;
    const sidecarKeys = new Set(parsed.keys);
    for (const k of CHINESE_ARTIST_DROP_LIST) {
      expect(sidecarKeys.has(k)).toBe(true);
    }
  });
});
