// Regression tests for scripts/drop-artist-leaks.mjs — the JS replacement for
// the former Python pair drop_kpop_leaks.py / drop_cpop_leaks.py. Ports the
// meaningful cases from the two deleted Python test files (drop matching,
// component-split matching incl. the `meets` and full-width-pipe delimiters,
// anomaly-ID drop, no-op no-rewrite, atomic write byte-shape, dry-run) on top
// of the REAL drop lists imported from the crawler dist (the @karaoke/scripts
// test script builds the crawler first, so dist is always present here).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOG_ANOMALY_IDS,
  KOREAN_CATALOG_ANOMALY_IDS,
  USAGE,
  parseArgs,
  runDropArtistLeaks,
} from './drop-artist-leaks.mjs';

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
      decisionsOut: null,
      help: false,
    });
    expect(parseArgs(['--list', 'chinese', '--dry-run']).dryRun).toBe(true);
  });

  it('accepts --decisions-out with a value and rejects it without one', () => {
    expect(parseArgs(['--list', 'korean', '--decisions-out', 'd.jsonl']).decisionsOut).toBe(
      'd.jsonl',
    );
    expect(() => parseArgs(['--list', 'korean', '--decisions-out'])).toThrow(/requires a path/);
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
    // tj-70438 (2026-07 CUTIE STREET KOR row) + the 2026-07-20 leak triage
    // (10 Western-pop tj-* + the CUTIE STREET Korean row's positional blog id).
    expect([...KOREAN_CATALOG_ANOMALY_IDS].sort()).toEqual([
      'blog-1601-1',
      'tj-21873',
      'tj-23450',
      'tj-23502',
      'tj-70438',
      'tj-7653',
      'tj-79222',
      'tj-79627',
      'tj-79697',
      'tj-79756',
      'tj-79914',
      'tj-79973',
    ]);
  });

  it('korean: drops the 2026-07-20 Western-pop leaks by exact tj-* ID, keeps the JP homonym rows', async () => {
    // The Western-pop leaks drop by exact record ID — their credited artists
    // are NOT on the Korean drop list (and must not be, to spare the Japanese
    // homonyms). A Japanese girl-group MAX row and a Japanese anison LiSA row
    // (different TJ numbers, same artist string) must SURVIVE.
    const jpMax = { ...record('tj-30001', 'MAX', 'Tacata'), karaoke_numbers: { tj: '30001' } };
    const jpLisa = { ...record('tj-30002', 'LiSA', '紅蓮華'), karaoke_numbers: { tj: '30002' } };
    writeCorpus(corpusPath, [
      ...SURVIVORS,
      record('tj-79627', 'LiSA', 'Rockstar'), // BLACKPINK Lisa leak
      record('tj-23450', 'MAX,Felly', 'Acid Dreams'), // US MAX leak
      record('tj-21873', 'Mary McGregor', 'This Girl Has Turned Into A Woman'),
      jpMax,
      jpLisa,
    ]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'tj-30001', 'tj-30002']);
  });

  it('korean: drops the CUTIE STREET Korean-ver blog row (blog-1601-1), keeps the JP original', async () => {
    // blog-1601-1 is the KOR-language row (dropped by positional ID); the JP
    // original (blog-1601-0) and the JOYSOUND-hosted "(Korean ver.)"
    // (blog-1601-19) are not anomaly IDs and must survive.
    writeCorpus(corpusPath, [
      ...SURVIVORS,
      {
        ...record('blog-1601-1', 'CUTIE STREET', '귀엽기만 하면 안 되나요?'),
        karaoke_numbers: { tj: '52093' },
      },
      {
        ...record('blog-1601-0', 'CUTIE STREET', 'かわいいだけじゃ だめですか?'),
        karaoke_numbers: { tj: '52410' },
      },
      {
        ...record('blog-1601-19', 'CUTIE STREET', 'かわいいだけじゃだめですか? (Korean ver.)'),
        karaoke_numbers: { tj: null },
      },
    ]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-1601-0', 'blog-1601-19', 'blog-2']);
  });

  it('chinese pass leaves the korean leak anomaly IDs alone (scoped to korean pass)', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-79627', 'LiSA', 'Rockstar')]);
    const code = await runDropArtistLeaks({ list: 'chinese', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'tj-79627']);
  });

  it('korean: drops a catalog-anomaly ID even though its artist (CUTIE STREET) matches no list', async () => {
    // CUTIE STREET is a Japanese act — not on any drop list and it must stay so
    // (their JP rows are admittable). tj-70438 is their KOR-language row; it
    // drops by exact ID, mirroring the crawl chain's reviewed-song-drop.
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-70438', 'CUTIE STREET', '프리큐큐')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
  });

  it('korean anomaly IDs are scoped to the korean pass (chinese pass keeps tj-70438)', async () => {
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-70438', 'CUTIE STREET', '프리큐큐')]);
    const code = await runDropArtistLeaks({ list: 'chinese', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'tj-70438']);
  });

  it('korean: keeps a drop-listed artist whose TJ is reviewed-song-allow-listed, drops the non-allowed one', async () => {
    // Mirrors the crawl chain (reviewed-song-allow step 2 before drop-list-reject
    // step 3): BOYNEXTDOOR is on the Korean drop list, but its genuine Japanese
    // release tj 52990 ("Count To Love") is curated into REVIEWED_TJ_SONG_ALLOW.
    // The allow-listed row survives; the ordinary BOYNEXTDOOR row drops.
    const allowed = {
      ...record('tj-52990', 'BOYNEXTDOOR', 'Count To Love'),
      karaoke_numbers: { tj: '52990', ky: null, joysound: null },
    };
    const dropped = {
      ...record('tj-43349', 'BOYNEXTDOOR', 'Nice Guy'),
      karaoke_numbers: { tj: '43349', ky: null, joysound: null },
    };
    writeCorpus(corpusPath, [...SURVIVORS, allowed, dropped]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'tj-52990']);
  });

  it('reviewed-song-allow is honored in the chinese pass too (uniform across --list modes)', async () => {
    // reviewed-song-allow is TJ-number-level and list-agnostic. A Chinese-drop-listed
    // act (BEYOND) whose TJ is reviewed-allow (27069) survives the chinese pass,
    // proving the allow gate is wired into both list modes.
    const allowed = {
      ...record('tj-27069', 'BEYOND', '大地'),
      karaoke_numbers: { tj: '27069', ky: null, joysound: null },
    };
    const dropped = {
      ...record('tj-70170', 'BEYOND', '海闊天空'),
      karaoke_numbers: { tj: '70170', ky: null, joysound: null },
    };
    writeCorpus(corpusPath, [...SURVIVORS, allowed, dropped]);
    const code = await runDropArtistLeaks({ list: 'chinese', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2', 'tj-27069']);
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

  it('--decisions-out (korean): writes only dropped rows with per-check reasons', async () => {
    const decisionsPath = join(dir, 'decisions.jsonl');
    writeCorpus(corpusPath, [
      ...SURVIVORS,
      record('tj-99999', '방탄소년단', 'Dynamite'), // artist match → korean-drop-list
      record('tj-70438', 'CUTIE STREET', '프리큐큐'), // korean anomaly ID → catalog-anomaly-id
    ]);
    const code = await runDropArtistLeaks({
      list: 'korean',
      corpusPath,
      decisionsOut: decisionsPath,
      log: quietLog,
    });
    expect(code).toBe(0);
    const lines = readFileSync(decisionsPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // ONLY the two dropped rows — survivors (admits) are never logged.
    expect(lines.map((l) => l.id).sort()).toEqual(['tj-70438', 'tj-99999']);
    for (const l of lines) {
      expect(l.decision).toBe('drop');
      expect(l.step).toBe('drop-artist-leaks');
    }
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
    expect(byId['tj-99999'].reason).toBe('korean-drop-list');
    expect(byId['tj-99999'].artist).toBe('방탄소년단');
    expect(byId['tj-99999'].title).toBe('Dynamite');
    expect(byId['tj-70438'].reason).toBe('catalog-anomaly-id');
  });

  it('--decisions-out (chinese): reason=chinese-drop-list', async () => {
    const decisionsPath = join(dir, 'decisions.jsonl');
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-70170', 'BEYOND', '大地')]);
    await runDropArtistLeaks({
      list: 'chinese',
      corpusPath,
      decisionsOut: decisionsPath,
      log: quietLog,
    });
    const lines = readFileSync(decisionsPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe('tj-70170');
    expect(lines[0].reason).toBe('chinese-drop-list');
    expect(lines[0].decision).toBe('drop');
    expect(lines[0].step).toBe('drop-artist-leaks');
  });

  it('--decisions-out: a reviewed-song-allow row that was SPARED is not logged as a drop', async () => {
    const decisionsPath = join(dir, 'decisions.jsonl');
    const allowed = {
      ...record('tj-52990', 'BOYNEXTDOOR', 'Count To Love'),
      karaoke_numbers: { tj: '52990', ky: null, joysound: null },
    };
    const dropped = {
      ...record('tj-43349', 'BOYNEXTDOOR', 'Nice Guy'),
      karaoke_numbers: { tj: '43349', ky: null, joysound: null },
    };
    writeCorpus(corpusPath, [...SURVIVORS, allowed, dropped]);
    await runDropArtistLeaks({
      list: 'korean',
      corpusPath,
      decisionsOut: decisionsPath,
      log: quietLog,
    });
    const lines = readFileSync(decisionsPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual(['tj-43349']);
    expect(lines[0].reason).toBe('korean-drop-list');
  });

  it('--decisions-out: writes an empty file when nothing dropped (clean corpus)', async () => {
    const decisionsPath = join(dir, 'decisions.jsonl');
    writeCorpus(corpusPath, SURVIVORS);
    const code = await runDropArtistLeaks({
      list: 'korean',
      corpusPath,
      decisionsOut: decisionsPath,
      log: quietLog,
    });
    expect(code).toBe(0);
    expect(readFileSync(decisionsPath, 'utf8')).toBe('');
  });

  it('flag-absent: no decision file is written and drops are unchanged', async () => {
    const decisionsPath = join(dir, 'decisions.jsonl');
    writeCorpus(corpusPath, [...SURVIVORS, record('tj-99999', '방탄소년단', 'Dynamite')]);
    const code = await runDropArtistLeaks({ list: 'korean', corpusPath, log: quietLog });
    expect(code).toBe(0);
    expect(existsSync(decisionsPath)).toBe(false);
    expect(readIds(corpusPath).sort()).toEqual(['blog-1', 'blog-2']);
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
