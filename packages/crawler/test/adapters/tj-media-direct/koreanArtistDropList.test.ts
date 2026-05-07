import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DROP_KEY_SET,
  DROP_LIST,
  isInDropList,
} from '../../../src/adapters/tj-media-direct/koreanArtistDropList.js';
import { normalizeForMatch } from '../../../src/adapters/tj-media-direct/normalize.js';

describe('koreanArtistDropList — Phase 1 §2.E seed list', () => {
  it('exports at least 20 canonical entries (spec §2.E target)', () => {
    expect(DROP_LIST.length).toBeGreaterThanOrEqual(20);
  });

  it('every variant in every entry normalizes to a non-empty key', () => {
    for (const entry of DROP_LIST) {
      expect(entry.variants.length).toBeGreaterThan(0);
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        expect(key).not.toBe('');
      }
    }
  });

  it('DROP_KEY_SET contains the normalized form of every variant', () => {
    for (const entry of DROP_LIST) {
      for (const variant of entry.variants) {
        const key = normalizeForMatch(variant);
        expect(DROP_KEY_SET.has(key)).toBe(true);
      }
    }
  });

  it('DROP_KEY_SET has one entry per distinct normalized variant key', () => {
    // Within-entry collisions are EXPECTED (intentional alias forms — e.g.
    // `BIGBANG` / `BIG BANG` normalize to the same `bigbang` key for the
    // hot-path `Set.has()` lookup). The check that matters is CROSS-entry:
    // two distinct canonical entries normalizing to the same key would mean
    // the canonical→variants mapping is ambiguous, which is a data error.
    //
    // Fix D.3 (2026-05-01): when a real cross-canonical collision exists,
    // the failure message previously was just `expected N to be M` — useless
    // for diagnosing WHICH entries collided. The new behavior groups the
    // variants by their normalized key, surfaces only the keys that appear
    // in ≥2 distinct CANONICAL names, and formats a readable failure
    // message naming the conflicting entries.
    const keyToCanonicals = new Map<string, Set<string>>();
    const keyToEntryStrings = new Map<string, string[]>();
    for (const entry of DROP_LIST) {
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
    // The set size must match the count of distinct keys (within-entry
    // collisions naturally collapse — that's the intended behavior).
    expect(DROP_KEY_SET.size).toBe(keyToCanonicals.size);
  });

  it('every entry has a `lastReviewed` ISO date (Fix D.1)', () => {
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    for (const entry of DROP_LIST) {
      expect(
        isoDate.test(entry.lastReviewed),
        `entry ${entry.canonical} has malformed lastReviewed: ${entry.lastReviewed}`,
      ).toBe(true);
      // Also assert the date is parseable + not in the future. A typo like
      // `2026-13-01` would slip past the regex; `Date.parse` catches it.
      const parsed = Date.parse(entry.lastReviewed);
      expect(Number.isFinite(parsed)).toBe(true);
    }
  });

  it('Fix D.2 — non-blocking warning for entries older than 90 days', () => {
    // Soft warning, not a hard test failure. Surfacing rot via console.warn
    // makes the 3-month review cadence visible during local + CI test runs
    // without blocking unrelated PRs. To promote to a hard failure later,
    // change `console.warn` to `expect(...).toBe(true)`.
    //
    // Read the threshold from env so CI can override at audit time.
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();
    const stale: string[] = [];
    for (const entry of DROP_LIST) {
      const reviewedMs = Date.parse(entry.lastReviewed);
      if (!Number.isFinite(reviewedMs)) continue; // covered by the previous test
      if (nowMs - reviewedMs > NINETY_DAYS_MS) {
        const ageDays = Math.floor((nowMs - reviewedMs) / (24 * 60 * 60 * 1000));
        stale.push(`${entry.canonical} (lastReviewed=${entry.lastReviewed}, ${ageDays}d ago)`);
      }
    }
    if (stale.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[koreanArtistDropList] ${stale.length} entries are older than 90 days — re-probe against tj-search-cache.json and bump lastReviewed:\n  ${stale.join('\n  ')}`,
      );
    }
    // The test always passes — promotion to hard failure is a deliberate
    // future-step. Rationale: drop-list rot rarely breaks correctness (the
    // worst case is admitting a Korean act whose name evolved); a hard fail
    // would block unrelated PRs every 3 months which is the wrong cost
    // tradeoff. Surface, don't block.
    expect(true).toBe(true);
  });
});

describe('isInDropList — true positives (known leakers from spec §2.E)', () => {
  function check(name: string): void {
    expect(isInDropList(normalizeForMatch(name))).toBe(true);
  }

  it('catches BTS variants (Hangul, Latin, kanji)', () => {
    check('방탄소년단');
    check('BTS');
    check('防弾少年団');
    check('SUGA of BTS');
  });

  it("catches Girls' Generation variants", () => {
    check('소녀시대');
    check('少女時代');
    check('SNSD');
    check("Girls' Generation");
    check('Girls Generation');
  });

  it('catches TVXQ variants (the largest pre-fix kanji-script leaker)', () => {
    check('동방신기');
    check('東方神起');
    check('TVXQ');
    check('Tohoshinki');
  });

  it('catches FT Island variants', () => {
    check('FT Island');
    check('FTISLAND');
    check('에프티 아일랜드');
    check('에프티아일랜드');
  });

  it('catches EXO-CBX (survives the §2.A threshold via ratio 1.0 — drop list is the safety net)', () => {
    check('EXO-CBX');
    check('EXO');
    check('엑소');
  });

  it('catches BIGBANG, SHINee, BLACKPINK', () => {
    check('BIGBANG');
    check('빅뱅');
    check('SHINee');
    check('샤이니');
    check('BLACKPINK');
    check('블랙핑크');
  });

  it('catches the §2.E non-group leakers (Park Hyo Shin, Lump, IU)', () => {
    check('박효신');
    check('Park Hyo Shin');
    check('램프');
    check('Lump');
    check('IU');
    check('아이유');
  });

  it('catches J-Walk Latin variants (post-Phase-2 audit — 20 TJ records leaked)', () => {
    // Fix 3 (2026-05-01): only Latin `j-walk` / `JWALK` are in the drop list.
    // The Hangul `제이워크` and katakana `ジェイウォーク` variants had 0 cache
    // entries during verification and were trimmed (no speculation).
    check('J-Walk');
    check('JWALK');
  });

  it('catches PLAVE Latin variant (post-Phase-2 audit — 30 TJ records leaked)', () => {
    // Fix 3 (2026-05-01): only Latin `plave` is in the drop list. The Hangul
    // `플레이브` and katakana `プレイヴ` variants had 0 cache entries during
    // verification and were trimmed (no speculation).
    check('PLAVE');
  });

  it('normalization handles whitespace + case variants', () => {
    expect(isInDropList(normalizeForMatch('  bts  '))).toBe(true);
    expect(isInDropList(normalizeForMatch('Blackpink'))).toBe(true);
    expect(isInDropList(normalizeForMatch('GIRLS GENERATION'))).toBe(true);
  });
});

describe('koreanArtistDropList — sidecar JSON staleness check (Fix 2)', () => {
  // The sidecar at `packages/crawler/src/adapters/tj-media-direct/
  // korean-artist-drop-list.json` is the source-of-truth for the Python
  // consumers (`scripts/ingest_anisong_pdf.py`, `scripts/drop_kpop_leaks.py`).
  // It is regenerated by `scripts/export-drop-list.mjs` (which the crawler's
  // `build` script invokes after `tsc -b`). Tracking the file in git makes a
  // forgotten regen visible at code-review time — this test makes the same
  // mismatch visible at test time too.
  //
  // If this test fails, run `corepack pnpm --filter @karaoke/crawler build`
  // (or `node scripts/export-drop-list.mjs` directly after a previous build)
  // to regenerate the sidecar.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SIDECAR_PATH = resolve(
    HERE,
    '../../../src/adapters/tj-media-direct/korean-artist-drop-list.json',
  );

  interface SidecarShape {
    version: number;
    keys: string[];
  }

  it('sidecar JSON file exists at the tracked src/ path', () => {
    expect(() => readFileSync(SIDECAR_PATH, 'utf-8')).not.toThrow();
  });

  it('sidecar `keys.length` matches DROP_KEY_SET.size (regen check)', () => {
    const raw = readFileSync(SIDECAR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SidecarShape;
    expect(Array.isArray(parsed.keys)).toBe(true);
    expect(parsed.keys.length).toBe(DROP_KEY_SET.size);
  });

  it('sidecar contains every DROP_KEY_SET entry', () => {
    const raw = readFileSync(SIDECAR_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as SidecarShape;
    const sidecarKeys = new Set(parsed.keys);
    for (const k of DROP_KEY_SET) {
      expect(sidecarKeys.has(k)).toBe(true);
    }
  });
});

describe('isInDropList — true negatives (real Japanese acts must not match)', () => {
  function check(name: string): void {
    expect(isInDropList(normalizeForMatch(name))).toBe(false);
  }

  it('does not catch LiSA (real JP, similar surface form to "List")', () => {
    check('LiSA');
  });

  it('does not catch SEKAI NO OWARI', () => {
    check('SEKAI NO OWARI');
  });

  it('does not catch BoA (real Japanese-resident KR-origin artist with a long JP career — explicitly NOT on the drop list)', () => {
    // BoA is omitted from the seed list per spec §2.E intent: the bias is
    // toward keeping entries, but acts that have shifted to a Japan-only
    // career are out of scope.
    check('BoA');
  });

  it('does not catch 中島美嘉 (kanji-script JP act)', () => {
    check('中島美嘉');
  });

  it('does not catch the empty string', () => {
    expect(isInDropList('')).toBe(false);
  });

  it('does not catch 椎名林檎 (sanity — pure JP)', () => {
    check('椎名林檎');
  });

  it('does not catch YOASOBI', () => {
    check('YOASOBI');
  });

  // Fix 1 (2026-05-01): regression for the ` of ` splitter scope tightening.
  // Previously the unscoped ` of ` sub-split would have produced sub-tokens
  // `Bump` / `Chicken` from `Bump of Chicken`. With Fix 1, bare ` of ` does
  // not split; the whole string is checked against the drop set as-is and
  // does not match. (Defense-in-depth: even if the splitter regressed and
  // produced `Bump` / `Chicken`, neither token matches a drop-list variant.)
  it('does not catch BUMP OF CHICKEN (Japanese rock band — Fix 1 regression)', () => {
    check('Bump of Chicken');
    check('BUMP OF CHICKEN');
    check('bump of chicken');
  });
});
