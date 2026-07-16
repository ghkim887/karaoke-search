// Unit tests for the post-crawl pipeline runner SKELETON (step table shape,
// ordering, stop-on-failure, continueOnError pass-through, skip handling,
// exit codes). Real pipeline steps are NOT exercised here — step commands are
// replaced with tiny `node -e` fakes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CORPUS,
  REPO_ROOT,
  buildChildEnv,
  buildSteps,
  parseArgs,
  runSteps,
} from './run-post-crawl-pipeline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = resolve(__dirname, 'run-post-crawl-pipeline.mjs');

const NODE = process.execPath;
const quietLog = { error: () => {}, info: () => {} };

/** Fake step: appends `name` to markerFile, exits with `exitCode`. */
function fakeStep(name, markerFile, exitCode = 0, extra = {}) {
  const js = `require('node:fs').appendFileSync(${JSON.stringify(markerFile)}, ${JSON.stringify(`${name}\n`)}); process.exit(${exitCode});`;
  return { name, command: [NODE, '-e', js], ...extra };
}

describe('buildSteps', () => {
  const EXPECTED_ORDER = [
    'atomic-rename',
    'splitter-parity',
    'tjpdf-catalog-ingest',
    'title-ko-stage1',
    'replay-merger',
    'drop-kpop-leaks',
    'drop-cpop-leaks',
    'title-ko-stage2-replay',
    'title-ko-manual-fixes',
    'prune-artist-nationality-cache',
    'validate-songs-json',
    'blog-ky-parity',
  ];

  it('produces the 12 crawl.yml steps in the load-bearing order', () => {
    expect(buildSteps().map((s) => s.name)).toEqual(EXPECTED_ORDER);
  });

  it('marks the Stage 2 replay and the report-only blog↔KY parity as continueOnError', () => {
    const flagged = buildSteps()
      .filter((s) => s.continueOnError)
      .map((s) => s.name);
    expect(flagged).toEqual(['title-ko-stage2-replay', 'blog-ky-parity']);
  });

  it('threads the corpus path into every parameterized step', () => {
    const steps = buildSteps('tmp/copy.json');
    const byName = Object.fromEntries(steps.map((s) => [s.name, s.command]));
    expect(byName['atomic-rename'][2]).toContain('"tmp/copy.json.tmp"');
    expect(byName['atomic-rename'][2]).toContain('"tmp/copy.json"');
    expect(byName['title-ko-stage1']).toContain('tmp/copy.json');
    expect(byName['title-ko-stage2-replay']).toContain('tmp/copy.json');
    expect(byName['title-ko-manual-fixes']).toContain('tmp/copy.json');
    expect(byName['validate-songs-json']).toContain('tmp/copy.json');
  });

  it('defaults to the committed corpus path', () => {
    const steps = buildSteps();
    const validate = steps.find((s) => s.name === 'validate-songs-json');
    expect(validate.command).toContain(DEFAULT_CORPUS);
  });

  it('omits --decisions-out from the drop steps when no decisions dir is given', () => {
    const steps = buildSteps();
    const kpop = steps.find((s) => s.name === 'drop-kpop-leaks');
    const cpop = steps.find((s) => s.name === 'drop-cpop-leaks');
    expect(kpop.command).toEqual([NODE, 'scripts/drop-artist-leaks.mjs', '--list', 'korean']);
    expect(cpop.command).toEqual([NODE, 'scripts/drop-artist-leaks.mjs', '--list', 'chinese']);
  });

  it('threads FILTER_DECISIONS_DIR into ONLY the two drop-artist-leaks steps', () => {
    const steps = buildSteps(DEFAULT_CORPUS, '/tmp/fd');
    const byName = Object.fromEntries(steps.map((s) => [s.name, s.command]));
    expect(byName['drop-kpop-leaks']).toEqual([
      NODE,
      'scripts/drop-artist-leaks.mjs',
      '--list',
      'korean',
      '--decisions-out',
      join('/tmp/fd', 'drop-kpop-leaks.jsonl'),
    ]);
    expect(byName['drop-cpop-leaks']).toEqual([
      NODE,
      'scripts/drop-artist-leaks.mjs',
      '--list',
      'chinese',
      '--decisions-out',
      join('/tmp/fd', 'drop-cpop-leaks.jsonl'),
    ]);
    // No other step is given --decisions-out.
    for (const s of steps.filter((s) => !s.name.startsWith('drop-'))) {
      expect(s.command).not.toContain('--decisions-out');
    }
  });
});

describe('parseArgs', () => {
  it('defaults corpus and accepts repeated --skip', () => {
    const args = parseArgs(['--skip', 'a', '--skip', 'b']);
    expect(args.corpus).toBe(DEFAULT_CORPUS);
    expect(args.corpusOverridden).toBe(false);
    expect(args.skip).toEqual(['a', 'b']);
  });

  it('records a corpus override', () => {
    const args = parseArgs(['--corpus', 'x.json']);
    expect(args.corpus).toBe('x.json');
    expect(args.corpusOverridden).toBe(true);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--corpus'])).toThrow(/requires a path/);
    expect(() => parseArgs(['--skip'])).toThrow(/requires a step name/);
  });

  it('recognizes --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });
});

describe('buildChildEnv', () => {
  it('sets KARAOKE_SONGS_JSON to the resolved absolute path when --corpus is given', () => {
    const args = parseArgs(['--corpus', 'tmp/copy.json']);
    const env = buildChildEnv(args, { PATH: '/bin' });
    expect(env.KARAOKE_SONGS_JSON).toBe(resolve(REPO_ROOT, 'tmp/copy.json'));
    expect(env.PATH).toBe('/bin');
  });

  it('passes an absolute --corpus through unchanged', () => {
    const abs = resolve(tmpdir(), 'songs.json');
    const env = buildChildEnv(parseArgs(['--corpus', abs]), {});
    expect(env.KARAOKE_SONGS_JSON).toBe(abs);
  });

  it('DELETES a preset KARAOKE_SONGS_JSON when --corpus is not given (no split-brain)', () => {
    // Without the delete, the five env-aware steps would follow the caller's
    // preset corpus while argv-threaded steps used the default — the final
    // validate gate would check the wrong file.
    const env = buildChildEnv(parseArgs([]), {
      PATH: '/bin',
      KARAOKE_SONGS_JSON: '/somewhere/else.json',
    });
    expect('KARAOKE_SONGS_JSON' in env).toBe(false);
    expect(env.PATH).toBe('/bin');
  });

  it('strips a preset case-insensitively (Windows env-var names)', () => {
    const env = buildChildEnv(parseArgs([]), {
      karaoke_songs_json: '/somewhere/else.json',
    });
    expect(Object.keys(env)).toEqual([]);
  });
});

describe('runSteps', () => {
  let dir;
  let marker;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pcp-runner-'));
    marker = join(dir, 'marker.txt');
    writeFileSync(marker, '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const ranSteps = () => readFileSync(marker, 'utf8').split('\n').filter(Boolean);

  it('runs steps sequentially in table order', async () => {
    const steps = [fakeStep('one', marker), fakeStep('two', marker), fakeStep('three', marker)];
    const { ok, results } = await runSteps(steps, { cwd: dir, log: quietLog });
    expect(ok).toBe(true);
    expect(ranSteps()).toEqual(['one', 'two', 'three']);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('stops on a hard failure and marks later steps not-run', async () => {
    const steps = [fakeStep('one', marker), fakeStep('boom', marker, 1), fakeStep('after', marker)];
    const { ok, results } = await runSteps(steps, { cwd: dir, log: quietLog });
    expect(ok).toBe(false);
    expect(ranSteps()).toEqual(['one', 'boom']);
    expect(results).toEqual([
      { name: 'one', status: 'ok' },
      { name: 'boom', status: 'failed' },
      { name: 'after', status: 'not-run' },
    ]);
  });

  it('continues past a continueOnError failure with exit code 0 overall', async () => {
    const steps = [
      fakeStep('soft-fail', marker, 1, { continueOnError: true }),
      fakeStep('after', marker),
    ];
    const { ok, results } = await runSteps(steps, { cwd: dir, log: quietLog });
    expect(ok).toBe(true);
    expect(ranSteps()).toEqual(['soft-fail', 'after']);
    expect(results).toEqual([
      { name: 'soft-fail', status: 'failed-continued' },
      { name: 'after', status: 'ok' },
    ]);
  });

  it('emits a GitHub ::warning:: workflow command for a failed-continued step', async () => {
    const infoLines = [];
    const capturingLog = { error: () => {}, info: (msg) => infoLines.push(msg) };
    const steps = [fakeStep('soft-fail', marker, 1, { continueOnError: true })];
    await runSteps(steps, { cwd: dir, log: capturingLog });
    expect(infoLines).toContain('::warning::soft-fail failed (continueOnError)');
  });

  it('does NOT emit ::warning:: for ok or hard-failed steps', async () => {
    const infoLines = [];
    const capturingLog = { error: () => {}, info: (msg) => infoLines.push(msg) };
    const steps = [fakeStep('one', marker), fakeStep('boom', marker, 1)];
    await runSteps(steps, { cwd: dir, log: capturingLog });
    expect(infoLines.filter((l) => l.startsWith('::warning::'))).toEqual([]);
  });

  it('skips named steps without executing them', async () => {
    const steps = [fakeStep('one', marker), fakeStep('two', marker)];
    const { ok, results } = await runSteps(steps, { skip: ['one'], cwd: dir, log: quietLog });
    expect(ok).toBe(true);
    expect(ranSteps()).toEqual(['two']);
    expect(results).toEqual([
      { name: 'one', status: 'skipped' },
      { name: 'two', status: 'ok' },
    ]);
  });

  it('rejects a --skip name that matches no step', async () => {
    const steps = [fakeStep('one', marker)];
    await expect(runSteps(steps, { skip: ['typo'], cwd: dir, log: quietLog })).rejects.toThrow(
      /no such step/,
    );
    expect(ranSteps()).toEqual([]);
  });

  it('treats an unspawnable command as a hard failure', async () => {
    const steps = [
      { name: 'ghost', command: [join(dir, 'does-not-exist.exe')] },
      fakeStep('after', marker),
    ];
    const { ok, results } = await runSteps(steps, { cwd: dir, log: quietLog });
    expect(ok).toBe(false);
    expect(results[0]).toEqual({ name: 'ghost', status: 'failed' });
    expect(results[1]).toEqual({ name: 'after', status: 'not-run' });
  });
});

describe('CLI exit codes (real process)', () => {
  const ALL_STEPS = buildSteps().map((s) => s.name);

  it('exits 0 when every step is skipped', () => {
    const skipArgs = ALL_STEPS.flatMap((name) => ['--skip', name]);
    const res = spawnSync(NODE, [RUNNER_PATH, ...skipArgs], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
  });

  it('exits 1 when the first step fails hard (rename of a missing tmp file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pcp-cli-'));
    try {
      const skipArgs = ALL_STEPS.filter((name) => name !== 'atomic-rename').flatMap((name) => [
        '--skip',
        name,
      ]);
      const res = spawnSync(
        NODE,
        [RUNNER_PATH, '--corpus', join(dir, 'absent.json'), ...skipArgs],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      expect(res.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 on an unknown flag', () => {
    const res = spawnSync(NODE, [RUNNER_PATH, '--nope'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(1);
  });

  it('exits 0 on --help and prints usage', () => {
    const res = spawnSync(NODE, [RUNNER_PATH, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('usage:');
  });
});
