import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readResumeSkipSet } from './joysound-detail-sweep.mjs';

// readResumeSkipSet streams the resume decision-log line-by-line (never a
// whole-file string read, which dies at V8's ~512MB string cap at fullCatalog
// scale). These tests pin its CLI-observable behavior at current scale: the
// skip-set contents, the torn-final-line truncation (by UTF-8 byte offset) and
// its file side effect, and the log messages.

let dir;
let warnSpy;
let logSpy;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-resume-skip-set-'));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

function decisionLine(naviGroupId, songName) {
  return JSON.stringify({ naviGroupId, selSongNo: `${naviGroupId}-001`, songName });
}

it('returns an empty skip set when the log does not exist', async () => {
  const skip = await readResumeSkipSet(join(dir, 'missing.jsonl'));
  expect(skip.size).toBe(0);
  expect(warnSpy).not.toHaveBeenCalled();
});

it('collects every decided naviGroupId from a clean newline-terminated log', async () => {
  const path = join(dir, 'clean.jsonl');
  const content = `${decisionLine('A', 'あ')}\n${decisionLine('B', 'beta')}\n${decisionLine('C', 'ガンマ')}\n`;
  writeFileSync(path, content, 'utf8');

  const skip = await readResumeSkipSet(path);

  expect([...skip].sort()).toEqual(['A', 'B', 'C']);
  // A clean log is not rewritten or truncated.
  expect(readFileSync(path, 'utf8')).toBe(content);
  expect(warnSpy).not.toHaveBeenCalled();
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0][0]).toContain('3 naviGroupId(s) already decided');
});

it('truncates a torn final line by BYTE offset and excludes it from the skip set', async () => {
  const path = join(dir, 'torn.jsonl');
  // Keep a line with a multibyte char (あ = 3 UTF-8 bytes) so a byte-offset
  // truncation differs from a char-count one, then append a torn fragment with
  // no trailing newline.
  const keptPrefix = `${decisionLine('A', 'あ')}\n${decisionLine('B', 'beta')}\n`;
  const tornFragment = '{"naviGroupId":"C","selSongNo":"C-001"';
  writeFileSync(path, keptPrefix + tornFragment, 'utf8');
  const keepBytes = Buffer.byteLength(keptPrefix, 'utf8');

  const skip = await readResumeSkipSet(path);

  expect([...skip].sort()).toEqual(['A', 'B']);
  // The on-disk log is truncated to the kept prefix (byte-exact) and is once
  // again fully newline-terminated.
  expect(statSync(path).size).toBe(keepBytes);
  expect(readFileSync(path, 'utf8')).toBe(keptPrefix);
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy.mock.calls[0][0]).toContain('dropped a torn final line');
});

it('truncates a whole-file torn line (no newline at all) to zero bytes', async () => {
  const path = join(dir, 'all-torn.jsonl');
  writeFileSync(path, '{"naviGroupId":"A"', 'utf8');

  const skip = await readResumeSkipSet(path);

  expect(skip.size).toBe(0);
  expect(statSync(path).size).toBe(0);
  expect(warnSpy).toHaveBeenCalledTimes(1);
});

it('skips blank lines and rows without a usable naviGroupId', async () => {
  const path = join(dir, 'sparse.jsonl');
  const content = [
    decisionLine('A', 'a'),
    '',
    '   ',
    JSON.stringify({ naviGroupId: '', selSongNo: 'x' }),
    JSON.stringify({ selSongNo: 'y' }),
    decisionLine('B', 'b'),
    '',
  ].join('\n');
  writeFileSync(path, `${content}\n`, 'utf8');

  const skip = await readResumeSkipSet(path);

  expect([...skip].sort()).toEqual(['A', 'B']);
  expect(warnSpy).not.toHaveBeenCalled();
});
