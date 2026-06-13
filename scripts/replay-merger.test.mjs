import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELTA_THRESHOLD, MIN_NON_FATAL_DELTA, runReplay } from './replay-merger.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const MERGE_JS = resolve(HERE, '../packages/crawler/dist/merge.js');
const ALIASES_JS = resolve(HERE, '../packages/crawler/dist/aliases.js');

if (!existsSync(MERGE_JS) || !existsSync(ALIASES_JS)) {
  throw new Error(
    'packages/crawler/dist is missing — run `corepack pnpm --filter @karaoke/crawler build` first',
  );
}

function record(overrides = {}) {
  return {
    id: 'blog-1',
    source_url: 'https://example.test/source',
    title_primary: 'さよなら',
    title_ko: null,
    artist_primary: '米津玄師',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: null },
    crawled_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Write a corpus fixture with NON-canonical bytes (compact JSON, no trailing
 * newline) so "the gate did not write" is provable: any write through
 * writeCorpusAtomic would re-serialise to indent=2 + trailing newline.
 */
function writeCompactCorpus(path, records) {
  writeFileSync(path, JSON.stringify(records), 'utf-8');
}

/** A corpus whose merge collapses 3 same-TJ-number duplicates into 1 (delta 2). */
function tripleDuplicateCorpus() {
  return [
    record({ id: 'blog-1', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
    record({ id: 'tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
    record({ id: 'blog-2', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
  ];
}

describe('replay-merger runReplay safety gates', () => {
  let dir;
  let songsPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karaoke-replay-merger-'));
    songsPath = join(dir, 'songs.json');
    // Silence the structured report; gate assertions read the spy calls.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function run(extraOptions = {}) {
    return runReplay({
      songsPath,
      mergeJsPath: MERGE_JS,
      aliasesJsPath: ALIASES_JS,
      ...extraOptions,
    });
  }

  it('writes the merged corpus when the delta is within the threshold', async () => {
    const records = [
      // Tier A pair: same TJ number -> collapses to one record (delta 1).
      record({ id: 'blog-1', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
      record({ id: 'tj-100', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
      // Unrelated record: distinct title/artist/number, must survive untouched.
      record({
        id: 'blog-2',
        title_primary: '夜に駆ける',
        artist_primary: 'YOASOBI',
        karaoke_numbers: { tj: '200', ky: null, joysound: null },
      }),
    ];
    writeCompactCorpus(songsPath, records);

    const result = await run();

    expect(result).toMatchObject({
      exitCode: 0,
      wrote: true,
      beforeCount: 3,
      afterCount: 2,
      delta: 1,
    });
    const raw = readFileSync(songsPath, 'utf-8');
    // Canonical pipeline byte-shape: indent=2 + trailing newline.
    expect(raw.endsWith(']\n')).toBe(true);
    const after = JSON.parse(raw);
    expect(after).toHaveLength(2);
    const tjNumbers = after.map((r) => r.karaoke_numbers.tj).sort();
    expect(tjNumbers).toEqual(['100', '200']);
    expect(after.find((r) => r.karaoke_numbers.tj === '200')).toMatchObject({
      id: 'blog-2',
      title_primary: '夜に駆ける',
    });
    expect(existsSync(`${songsPath}.tmp`)).toBe(false);
  });

  it('aborts with exit 2 and leaves the corpus untouched when the delta exceeds the threshold', async () => {
    writeCompactCorpus(songsPath, tripleDuplicateCorpus());
    const rawBefore = readFileSync(songsPath, 'utf-8');

    // delta 2 > injected threshold 1 -> safety gate fires.
    const result = await run({ maxDeltaThreshold: 1 });

    expect(result).toMatchObject({ exitCode: 2, wrote: false, delta: 2 });
    expect(readFileSync(songsPath, 'utf-8')).toBe(rawBefore);
    expect(existsSync(`${songsPath}.tmp`)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      '[replay-merger] SAFETY GATE: delta=2 exceeds threshold of 1. Refusing to write.',
    );
  });

  it('pins the threshold comparison as strict: delta == threshold still writes', async () => {
    // The gate is `delta > maxDeltaThreshold` (see replay-merger.mjs step 6),
    // so a delta exactly AT the threshold passes and the corpus is written.
    writeCompactCorpus(songsPath, tripleDuplicateCorpus());

    const result = await run({ maxDeltaThreshold: 2 });

    expect(result).toMatchObject({ exitCode: 0, wrote: true, delta: 2 });
    expect(JSON.parse(readFileSync(songsPath, 'utf-8'))).toHaveLength(1);
  });

  it('treats a negative delta as fatal (exit 2) without writing', async () => {
    // No real merger can inflate the corpus, so inject a broken stand-in that
    // returns more records than it was given.
    const fakeMergePath = join(dir, 'fake-merge.mjs');
    writeFileSync(
      fakeMergePath,
      [
        'export function mergeRecords(records) {',
        "  return { records: [...records, { ...records[0], id: 'phantom-extra' }], conflicts: [] };",
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeCompactCorpus(songsPath, [
      record({ id: 'blog-1' }),
      record({ id: 'blog-2', title_primary: '夜に駆ける', artist_primary: 'YOASOBI' }),
    ]);
    const rawBefore = readFileSync(songsPath, 'utf-8');

    const result = await run({ mergeJsPath: fakeMergePath });

    expect(result).toMatchObject({ exitCode: 2, wrote: false, delta: -1 });
    expect(readFileSync(songsPath, 'utf-8')).toBe(rawBefore);
    expect(existsSync(`${songsPath}.tmp`)).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      '[replay-merger] FATAL: delta is negative (-1). Merger produced more records than input. Aborting.',
    );
  });

  it('skips the write entirely when nothing merged and nothing was alias-rewritten', async () => {
    writeCompactCorpus(songsPath, [
      record({ id: 'blog-1', karaoke_numbers: { tj: '100', ky: null, joysound: null } }),
      record({
        id: 'blog-2',
        title_primary: '夜に駆ける',
        artist_primary: 'YOASOBI',
        karaoke_numbers: { tj: '200', ky: null, joysound: null },
      }),
    ]);
    const rawBefore = readFileSync(songsPath, 'utf-8');

    const result = await run();

    expect(result).toMatchObject({ exitCode: 0, wrote: false, delta: 0, changedRecordCount: 0 });
    // The fixture bytes are non-canonical (compact, no trailing newline); any
    // write would have re-serialised them. Byte-identity proves the skip.
    expect(readFileSync(songsPath, 'utf-8')).toBe(rawBefore);
    expect(existsSync(`${songsPath}.tmp`)).toBe(false);
    expect(console.log).toHaveBeenCalledWith(
      '[replay-merger] no Tier C merges fired and no alias rewrites — corpus already current; skipping write',
    );
  });

  it('writes on delta 0 when cross-record artist_ko propagation changed a record', async () => {
    // Two records share the full-artist key (YOASOBI) but have different titles
    // and karaoke numbers, so NOTHING merges (delta 0) and the alias resolver
    // leaves both untouched (no pipe form, no alias match). The only change is
    // the merger filling the JOYSOUND row's missing artist_ko from the donor —
    // a same-id content change that the old `delta === 0 && no alias rewrites`
    // skip would have wrongly dropped.
    writeCompactCorpus(songsPath, [
      record({
        id: 'blog-1',
        title_primary: '夜に駆ける',
        artist_primary: 'YOASOBI',
        artist_ko: '요아소비',
        karaoke_numbers: { tj: null, ky: null, joysound: null },
      }),
      record({
        id: 'joysound-700100',
        title_primary: 'アイドル',
        artist_primary: 'YOASOBI',
        artist_ko: null,
        karaoke_numbers: { tj: null, ky: null, joysound: '700100' },
      }),
    ]);

    const result = await run();

    expect(result).toMatchObject({
      exitCode: 0,
      wrote: true,
      delta: 0,
      aliasSplits: 0,
      aliasReKeys: 0,
      changedRecordCount: 1,
    });
    const after = JSON.parse(readFileSync(songsPath, 'utf-8'));
    // No song merge — both rows survive.
    expect(after).toHaveLength(2);
    // The JOYSOUND row's missing artist_ko was filled from the donor.
    expect(after.find((r) => r.id === 'joysound-700100')?.artist_ko).toBe('요아소비');
    // Donor untouched.
    expect(after.find((r) => r.id === 'blog-1')?.artist_ko).toBe('요아소비');
  });

  it('writes on delta 0 when the alias resolver rewrote artist_primary', async () => {
    // The no-op skip requires BOTH delta == 0 AND zero alias rewrites; a
    // pipe-form split alone must still persist.
    writeCompactCorpus(songsPath, [
      record({ id: 'blog-1', artist_primary: 'スピッツ｜Spitz' }),
      record({ id: 'blog-2', title_primary: '夜に駆ける', artist_primary: 'YOASOBI' }),
    ]);

    const result = await run();

    expect(result).toMatchObject({ exitCode: 0, wrote: true, delta: 0, aliasSplits: 1 });
    const after = JSON.parse(readFileSync(songsPath, 'utf-8'));
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.id === 'blog-1')).toMatchObject({
      artist_primary: 'スピッツ',
      artist_aliases: ['Spitz'],
    });
  });

  it('exports the production gate defaults unchanged', () => {
    expect(MAX_DELTA_THRESHOLD).toBe(1000);
    expect(MIN_NON_FATAL_DELTA).toBe(0);
  });

  it('does not run the pipeline when merely imported in a fresh process (main-guard)', () => {
    // Spawn a real child process so the main-guard sees a non-CLI argv[1].
    // A guard inversion would print the report banner (and worse, run the
    // full pipeline against the repo corpus) on plain import.
    const scriptUrl = pathToFileURL(resolve(HERE, 'replay-merger.mjs')).href;
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(scriptUrl)}); console.log('IMPORT-ONLY-OK');`,
      ],
      { encoding: 'utf-8' },
    );
    expect(stdout).toContain('IMPORT-ONLY-OK');
    expect(stdout).not.toContain('Replay-merger report');
  });
});
