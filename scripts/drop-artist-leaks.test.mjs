// Regression tests for scripts/drop-artist-leaks.mjs — the JS replacement for
// the former Python pair drop_kpop_leaks.py / drop_cpop_leaks.py. Ports the
// meaningful cases from the two deleted Python test files (drop matching,
// component-split matching incl. the `meets` and full-width-pipe delimiters,
// anomaly-ID drop, no-op no-rewrite, atomic write byte-shape, dry-run) on top
// of the REAL drop lists imported from the crawler dist (the @karaoke/scripts
// test script builds the crawler first, so dist is always present here).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_ANOMALY_IDS, USAGE, parseArgs, runDropArtistLeaks } from './drop-artist-leaks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, 'drop-artist-leaks.mjs');
const NODE = process.execPath;

const quietLog = { log: () => {}, error: () => {} };

/** Minimal schema-shaped record. */
function record(id, artist, title = '夜に駆ける') {
  return {
    id,
    source_url: `https://example.com/${id}`,
    title_primary: title,
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj: '68425', ky: null, joysound: null },
    crawled_at: '2026-01-01T00:00:00+00:00',
  };
}

/** The two records that must always survive every pass. */
const SURVIVORS = [record('blog-1', 'YOASOBI'), record('blog-2', 'LiSA', '紅蓮華')];

function writeCorpus(path, records) {
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, 'utf-8');
}

function readIds(path) {
  return JSON.parse(readFileSync(path, 'utf-8')).map((r) => r.id);
}

describe('parseArgs', () => {
  it('requires --list and validates its value', () => {
    expect(() => parseArgs([])).toThrow(/--list korean\|chinese is required/);
    expect(() => parseArgs(['--list'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--list', 'martian'])).toThrow(/must be korean or chinese/);
  });

  it('accepts korean/chinese and --dry-run', () => {
    expect(parseArgs(['--list', 'korean'])).toEqual({
      list: 'korean',
      dryRun: false,
      help: false,
    });
    expect(parseArgs(['--list', 'chinese', '--dry-run']).dryRun).toBe(true);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--list', 'korean', '--frobnicate'])).toThrow(/unknown argument/);
  });

  it('allows --help without --list', () => {
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('runDropArtistLeaks', () => {
  let dir;
  let corpusPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drop-artist-leaks-'));
    corpusPath = join(dir, 'songs.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('korean: drops a drop-list artist (방탄소년단), keeps Japanese acts', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-99999', '방탄소년단', 'Dynamite')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('korean: drops via feat-paren component match (imase(Feat.정국))', async () => {
    // 정국 (Jungkook) is a BTS drop-list variant — only the component scan
    // can catch it inside the (Feat. …) parenthetical.
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-90001', 'imase(Feat.정국)')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('korean: drops via the ` of ` sub-split inside a feat paren (MAX(Feat.RM of BTS))', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-90002', 'MAX(Feat.RM of BTS)')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('korean: drops via the `meets` delimiter (ported from the Python splitter tests)', async () => {
    // Without ` meets ` in the splitter, 방탄소년단 never surfaces as a
    // component and the record would survive.
    writeCorpus(corpusPath, [
      ...SURVIVORS,
      record('tj-90003', 'CHiCO with HoneyWorks meets 방탄소년단'),
    ]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('korean: drops via the full-width pipe ｜ delimiter (U+FF5C, blog alias form)', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-90004', '米津玄師｜BTS')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('korean: bare ` of ` outside a feat/prod paren does NOT split (Bump of Chicken survives)', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('blog-3', 'BUMP OF CHICKEN')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'blog-3']);
  });

  it('chinese: drops drop-list artists (BEYOND, F4) case-insensitively', async () => {
    writeCorpus(corpusPath, [
      ...SURVIVORS,
      record('tj-70170', 'beyond', '大地'),
      record('tj-80011', 'F4', '流星雨'),
    ]);
    const code = await runDropArtistLeaks({ list: 'chinese', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('chinese: drops a catalog-anomaly ID even though its artist (`-`) matches no list', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-72638', '-', '明天你是否依然爱我')]);
    const code = await runDropArtistLeaks({ list: 'chinese', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('chinese: anomaly IDs are scoped to the chinese pass (korean pass keeps tj-72638)', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-72638', '-', '明天你是否依然爱我')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'tj-72638']);
  });

  it('documents the reviewed anomaly-ID set', () => {
    expect([...CATALOG_ANOMALY_IDS].sort()).toEqual(['tj-71365', 'tj-72638']);
  });

  it('no-op run does NOT rewrite the file (bytes + mtime preserved)', async () => {
    writeCorpus(corpusPath, SURVIVORS);
    const bytesBefore = readFileSync(corpusPath);
    const mtimeBefore = statSync(corpusPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));

    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readFileSync(corpusPath).equals(bytesBefore)).toBe(true);
    expect(statSync(corpusPath).mtimeMs).toBe(mtimeBefore);
  });

  it('round-trip: dirty corpus → first run drops → second run is a byte-identical no-op', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-99999', '방탄소년단', 'Dynamite')]);
    expect(await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog })).toBe(0);

    const bytesAfterFirst = readFileSync(corpusPath);
    const mtimeAfterFirst = statSync(corpusPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));

    expect(await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog })).toBe(0);
    expect(readFileSync(corpusPath).equals(bytesAfterFirst)).toBe(true);
    expect(statSync(corpusPath).mtimeMs).toBe(mtimeAfterFirst);
  });

  it('atomic write byte-shape: indent=2, trailing newline, no .tmp left behind', async () => {
    const dirty = [...SURVIVORS, record('tj-99999', '방탄소년단', 'Dynamite')];
    writeCorpus(corpusPath, dirty);
    await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });

    const text = readFileSync(corpusPath, 'utf-8');
    expect(text).toBe(`${JSON.stringify(SURVIVORS, null, 2)}\n`);
    expect(text.endsWith('\n')).toBe(true);
    expect(() => statSync(`${corpusPath}.tmp`)).toThrow();
  });

  it('dry-run reports but does not modify the corpus (bytes + mtime preserved)', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-99999', '방탄소년단', 'Dynamite')]);
    const bytesBefore = readFileSync(corpusPath);
    const mtimeBefore = statSync(corpusPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));

    const lines = { out: [], err: [] };
    const capturingLog = {
      log: (msg) => lines.out.push(msg),
      error: (msg) => lines.err.push(msg),
    };
    const code = await runDropArtistLeaks({
      list: 'korean',
      corpusPath,
      dryRun: true,
      log: capturingLog,
    });
    expect(code).toBe(0);
    expect(readFileSync(corpusPath).equals(bytesBefore)).toBe(true);
    expect(statSync(corpusPath).mtimeMs).toBe(mtimeBefore);
    expect(lines.out.some((l) => l.includes('would drop'))).toBe(true);
    expect(lines.err).toContain('dry-run, no changes written');
  });

  it('missing corpus → exit code 2', async () => {
    const code = await runDropArtistLeaks({
      list: 'korean',
      corpusPath: join(dir, 'absent.json'),
      log: quietLog,
    });
    expect(code).toBe(2);
  });

  it('zero-key drop set → exit code 2, corpus untouched (Python empty-sidecar guard parity)', async () => {
    writeCorpus(corpusPath, SURVIVORS);
    const bytesBefore = readFileSync(corpusPath);
    const errors = [];
    const code = await runDropArtistLeaks({
      list: 'korean',
      corpusPath,
      log: { log: () => {}, error: (msg) => errors.push(msg) },
      predicates: {
        isDropKey: () => false,
        keyCount: 0,
        anomalyIds: new Set(),
        normalizeForMatch: (s) => s,
        splitArtistCollab: () => [],
      },
    });
    expect(code).toBe(2);
    expect(errors.some((l) => l.includes('zero keys'))).toBe(true);
    expect(readFileSync(corpusPath).equals(bytesBefore)).toBe(true);
  });
});

describe('CLI (real process)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drop-artist-leaks-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('honors KARAOKE_SONGS_JSON and drops through the real CLI path', () => {
    const corpusPath = join(dir, 'songs.json');
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-70170', 'BEYOND', '大地')]);
    const res = spawnSync(NODE, [SCRIPT_PATH, '--list', 'chinese'], {
      encoding: 'utf8',
      env: { ...process.env, KARAOKE_SONGS_JSON: corpusPath },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('dropped:      1');
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('exits 2 with usage on a missing/invalid --list', () => {
    const res = spawnSync(NODE, [SCRIPT_PATH], { encoding: 'utf8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain(USAGE);
  });

  it('exits 0 on --help and prints usage', () => {
    const res = spawnSync(NODE, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
  });
});
