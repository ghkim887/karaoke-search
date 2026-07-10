// Unit tests for scripts/ingest-tjpdf-catalog.mjs — the offline catalog→corpus
// ingest that replaces ingest_anisong_pdf.py. Predicates are injected (no
// crawler-dist build needed); file I/O uses a temp dir. Plus the re-homed
// cross-file guard-consistency pin (manual-fix guards vs the committed catalog),
// which replaces TestManualFixesGuardAlignment from the retired python test.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SOURCE_URL,
  buildIngestedCorpus,
  localNormalizeForMatch,
  runIngest,
} from './ingest-tjpdf-catalog.mjs';
import { readCatalog } from './probe-tjpdf-catalog.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SCRIPTS_DIR, 'data');

/** Predicate bundle: drop artists whose exact name is in `dropSet`. */
function predicates(dropSet = new Set()) {
  return {
    isArtistDropped: (artist) => dropSet.has(artist),
    normalizeForMatch: localNormalizeForMatch,
  };
}

function catEntry(pro, over = {}) {
  return {
    pro: String(pro),
    indexTitle: `title-${pro}`,
    subTitle: null,
    indexSong: `artist-${pro}`,
    sortTitleKo: `타이틀-${pro}`,
    sortSongKo: `아티스트-${pro}`,
    nationalcode: 'JPN',
    publishdate: '2020-01-01',
    ...over,
  };
}

function tjpdfRow(code, over = {}) {
  return {
    id: `tjpdf-${code}`,
    source_url: 'https://www.tjmedia.com/support/poster?cate_cd=P06',
    title_primary: `old-title-${code}`,
    title_ko: null,
    artist_primary: `artist-${code}`,
    artist_ko: null,
    karaoke_numbers: { tj: String(code), ky: null, joysound: null },
    crawled_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const FIXED_NOW = () => '2026-07-11T00:00:00.000Z';

describe('buildIngestedCorpus', () => {
  it('coverage-only: skips a code already carried by a non-tjpdf row; inserts brand-new', () => {
    const corpus = [
      {
        id: 'tj-100',
        source_url: 'x',
        title_primary: 'kept',
        title_ko: null,
        artist_primary: 'A',
        artist_ko: null,
        karaoke_numbers: { tj: '100', ky: null, joysound: null },
        crawled_at: '2026-01-01T00:00:00.000Z',
      },
    ];
    const catalog = [catEntry('100'), catEntry('200')];
    const { corpus: out, stats } = buildIngestedCorpus(catalog, corpus, {
      ...predicates(),
      nowIso: FIXED_NOW,
    });
    const ids = out.map((r) => r.id);
    expect(ids).toContain('tj-100'); // untouched
    expect(ids).not.toContain('tjpdf-100'); // coverage-only skip
    expect(ids).toContain('tjpdf-200'); // brand-new inserted
    expect(stats).toMatchObject({ alreadyInCorpus: 1, inserted: 1, droppedOld: 0 });
  });

  it('title_primary is verbatim indexTitle, title_ko null, artist_primary is indexSong, API source_url', () => {
    const catalog = [
      catEntry('28477', {
        indexTitle: '紫陽花アイ愛物語(パタリロ西遊記! OP)',
        indexSong: '美勇伝',
      }),
    ];
    const { corpus: out } = buildIngestedCorpus(catalog, [], {
      ...predicates(),
      nowIso: FIXED_NOW,
    });
    const rec = out.find((r) => r.id === 'tjpdf-28477');
    expect(rec.title_primary).toBe('紫陽花アイ愛物語(パタリロ西遊記! OP)');
    expect(rec.title_ko).toBeNull();
    expect(rec.artist_primary).toBe('美勇伝');
    expect(rec.source_url).toBe(SOURCE_URL);
    expect(rec.karaoke_numbers).toEqual({ tj: '28477', ky: null, joysound: null });
    expect(rec.crawled_at).toBe('2026-07-11T00:00:00.000Z'); // fresh for a new code
  });

  it('canonical key order matches the merger emission', () => {
    const corpus = [tjpdfRow('300', { artist_ko: '아티스트', artist_aliases: ['alias1'] })];
    const catalog = [catEntry('300')];
    const { corpus: out } = buildIngestedCorpus(catalog, corpus, {
      ...predicates(),
      nowIso: FIXED_NOW,
    });
    const rec = out.find((r) => r.id === 'tjpdf-300');
    expect(Object.keys(rec)).toEqual([
      'id',
      'source_url',
      'title_primary',
      'title_ko',
      'artist_primary',
      'artist_ko',
      'artist_aliases',
      'karaoke_numbers',
      'crawled_at',
    ]);
  });

  it('refresh: drops all existing tjpdf rows, preserves crawled_at + artist_ko for re-inserts', () => {
    const corpus = [
      tjpdfRow('300', { artist_ko: '아티스트300', crawled_at: '2025-05-05T05:05:05.005Z' }),
      tjpdfRow('301', { artist_ko: null }),
    ];
    const catalog = [catEntry('300'), catEntry('301')];
    const { corpus: out, stats } = buildIngestedCorpus(catalog, corpus, {
      ...predicates(),
      nowIso: FIXED_NOW,
    });
    expect(stats.droppedOld).toBe(2);
    expect(stats.inserted).toBe(2);
    const r300 = out.find((r) => r.id === 'tjpdf-300');
    expect(r300.crawled_at).toBe('2025-05-05T05:05:05.005Z'); // preserved
    expect(r300.artist_ko).toBe('아티스트300'); // preserved
    const r301 = out.find((r) => r.id === 'tjpdf-301');
    expect(r301.artist_ko).toBeNull();
  });

  it('artist-identity guard: drops preserved artist_ko + aliases when the artist changed', () => {
    const corpus = [
      tjpdfRow('400', {
        artist_primary: 'OLD ARTIST',
        artist_ko: '올드아티스트',
        artist_aliases: ['OldAlias'],
      }),
    ];
    // Catalog now reports a different artist for 400.
    const catalog = [catEntry('400', { indexSong: 'NEW ARTIST' })];
    const { corpus: out } = buildIngestedCorpus(catalog, corpus, {
      ...predicates(),
      nowIso: FIXED_NOW,
    });
    const rec = out.find((r) => r.id === 'tjpdf-400');
    expect(rec.artist_primary).toBe('NEW ARTIST');
    expect(rec.artist_ko).toBeNull(); // stale reading dropped
    expect(rec.artist_aliases).toBeUndefined(); // stale aliases dropped
  });

  it('artist-identity guard: keeps artist_ko + aliases when the artist is unchanged (case/space/NFKC)', () => {
    const corpus = [
      tjpdfRow('401', {
        artist_primary: '奥華子',
        artist_ko: '오쿠 하나코',
        artist_aliases: ['奥 華子'],
      }),
    ];
    const catalog = [catEntry('401', { indexSong: '奥華子' })];
    const { corpus: out } = buildIngestedCorpus(catalog, corpus, {
      ...predicates(),
      nowIso: FIXED_NOW,
    });
    const rec = out.find((r) => r.id === 'tjpdf-401');
    expect(rec.artist_ko).toBe('오쿠 하나코');
    expect(rec.artist_aliases).toEqual(['奥 華子']);
  });

  it('drop-list: a matching artist never mints a tjpdf row', () => {
    const catalog = [
      catEntry('500', { indexSong: 'TVXQ' }),
      catEntry('501', { indexSong: 'YOASOBI' }),
    ];
    const { corpus: out, stats } = buildIngestedCorpus(catalog, [], {
      ...predicates(new Set(['TVXQ'])),
      nowIso: FIXED_NOW,
    });
    expect(out.map((r) => r.id)).toEqual(['tjpdf-501']);
    expect(stats.droppedArtist).toBe(1);
  });

  it('throws on a malformed catalog entry', () => {
    expect(() =>
      buildIngestedCorpus([{ pro: '1', indexSong: 'x' }], [], {
        ...predicates(),
        nowIso: FIXED_NOW,
      }),
    ).toThrow(/missing\/empty required field "indexTitle"/);
  });

  it('fails fast on a duplicate pro in the catalog (naming the code)', () => {
    const catalog = [catEntry('700'), catEntry('701'), catEntry('700')];
    expect(() => buildIngestedCorpus(catalog, [], { ...predicates(), nowIso: FIXED_NOW })).toThrow(
      /duplicate pro "700"/,
    );
  });
});

describe('runIngest (file I/O)', () => {
  let dir;
  let catalogPath;
  let corpusPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ingest-'));
    catalogPath = join(dir, 'catalog.jsonl');
    corpusPath = join(dir, 'songs.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCatalog(entries) {
    writeFileSync(catalogPath, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8');
  }
  function writeCorpus(records) {
    writeFileSync(corpusPath, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
  }

  it('is byte-idempotent across two runs on unchanged inputs', () => {
    writeCatalog([catEntry('600'), catEntry('601')]);
    writeCorpus([tjpdfRow('600', { artist_ko: '아티스트600' })]);
    const opts = {
      catalogPath,
      corpusPath,
      predicates: predicates(),
      nowIso: FIXED_NOW,
      log: { error() {}, log() {} },
    };

    expect(runIngest(opts)).toBe(0);
    const after1 = readFileSync(corpusPath);
    expect(runIngest(opts)).toBe(0);
    const after2 = readFileSync(corpusPath);
    expect(after2.equals(after1)).toBe(true);

    const corpus = JSON.parse(after1.toString('utf-8'));
    expect(corpus.find((r) => r.id === 'tjpdf-600').crawled_at).toBe('2026-01-01T00:00:00.000Z');
    expect(corpus.find((r) => r.id === 'tjpdf-601')).toBeTruthy();
  });

  it('exits 2 on missing catalog or corpus, 1 on empty catalog', () => {
    const log = { error() {}, log() {} };
    expect(runIngest({ catalogPath, corpusPath, predicates: predicates(), log })).toBe(2); // no catalog
    writeCatalog([]);
    writeCorpus([]);
    expect(runIngest({ catalogPath, corpusPath, predicates: predicates(), log })).toBe(1); // empty catalog
  });
});

// ---------------------------------------------------------------------------
// Cross-file guard-consistency pin (re-homed from the retired python
// TestManualFixesGuardAlignment). Every tjpdf-* entry in
// scripts/data/title-ko-manual-fixes.json must carry the EXACT catalog title
// (NFKC) as its `title_primary` stale-fix guard — otherwise
// apply-manual-title-ko-fixes.mjs silently skips the owner-signed fix (the
// ingest runs before the manual-fix step, so the corpus reaches it with the
// API title).
// ---------------------------------------------------------------------------
describe('manual-fix guard ↔ catalog consistency', () => {
  it('every tjpdf manual-fix guard equals its catalog title (NFKC)', () => {
    const catalogPath = join(DATA_DIR, 'tjpdf-catalog.jsonl');
    const fixesPath = join(DATA_DIR, 'title-ko-manual-fixes.json');
    const catalog = readCatalog(catalogPath);
    const byCode = new Map(catalog.map((e) => [e.pro, e.indexTitle]));
    const fixes = JSON.parse(readFileSync(fixesPath, 'utf-8'));

    const tjpdfFixes = fixes.filter((f) => String(f.id).startsWith('tjpdf-'));
    expect(tjpdfFixes.length).toBeGreaterThan(0);
    for (const fix of tjpdfFixes) {
      const code = fix.id.slice('tjpdf-'.length);
      const catalogTitle = byCode.get(code);
      expect(
        catalogTitle,
        `catalog is missing tjpdf code ${code} referenced by a manual fix`,
      ).toBeTruthy();
      expect(
        fix.title_primary.normalize('NFKC'),
        `manual-fix guard for ${fix.id} must equal the catalog title (else the fix silently skips)`,
      ).toBe(catalogTitle.normalize('NFKC'));
    }
  });
});

// ---------------------------------------------------------------------------
// Second guard surface (ROADMAP R7, Option 2): the Stage-2 replay cache
// (scripts/data/llm-translations-chunk-*.json) stores a per-entry title_primary
// that applyDecisionsToCorpus NFKC-compares before re-applying a cached
// translation (translate_title_ko_via_agents.mjs:133-141) — a title mismatch
// silently skips the translation. After the R7 mass title change the cache was
// mechanically re-keyed to the API titles. This pin makes the cache and the
// committed catalog unable to drift apart again: every tjpdf cache entry whose
// code is in the catalog must carry the exact catalog title (NFKC).
// ---------------------------------------------------------------------------
describe('Stage-2 cache title_primary ↔ catalog consistency', () => {
  it('every catalog-covered tjpdf cache entry stores the exact catalog title (NFKC)', () => {
    const catalog = readCatalog(join(DATA_DIR, 'tjpdf-catalog.jsonl'));
    const byCode = new Map(catalog.map((e) => [e.pro, e.indexTitle]));

    const chunkFiles = readdirSync(DATA_DIR).filter((f) =>
      /^llm-translations-chunk-\d+\.json$/.test(f),
    );
    let checked = 0;
    for (const f of chunkFiles) {
      const entries = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8'));
      for (const e of entries) {
        if (!String(e.id).startsWith('tjpdf-')) continue;
        const code = e.id.slice('tjpdf-'.length);
        const catalogTitle = byCode.get(code);
        if (catalogTitle === undefined) continue; // dropped code — not in the catalog
        checked += 1;
        expect(
          e.title_primary.normalize('NFKC'),
          `Stage-2 cache title_primary for ${e.id} (in ${f}) must equal the catalog title, else applyDecisionsToCorpus silently skips its translation`,
        ).toBe(catalogTitle.normalize('NFKC'));
      }
    }
    // Guard against a no-op pin (e.g. cache files renamed away).
    expect(checked).toBeGreaterThan(300);
  });
});
