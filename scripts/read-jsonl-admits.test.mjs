import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CHECKPOINT1_EXCLUDED_SEL_SONG_NOS, readJsonlAdmits } from './build-joysound-candidate.mjs';

// readJsonlAdmits streams the decision-log line-by-line (never a whole-file
// string read). These tests pin its CLI-observable behavior at current scale:
// the admit records and their order, the non-blank line total, the CHECKPOINT-1
// decision capture, and the throw on a malformed line.

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'read-jsonl-admits-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLog(name, rows) {
  const path = join(dir, name);
  writeFileSync(
    path,
    `${rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`,
    'utf8',
  );
  return path;
}

it('collects admit rows in file order and counts every non-blank line', async () => {
  const [suspect] = CHECKPOINT1_EXCLUDED_SEL_SONG_NOS;
  const admitA = { selSongNo: '640256', decision: 'admit', naviGroupId: 'n1' };
  const dropB = { selSongNo: '640257', decision: 'drop', naviGroupId: 'n2' };
  const admitSuspect = { selSongNo: suspect, decision: 'admit', naviGroupId: 'n3' };
  const rejectD = { selSongNo: '640258', decision: 'reject', naviGroupId: 'n4' };
  const path = writeLog('log.jsonl', [admitA, '', dropB, '   ', admitSuspect, rejectD]);

  const { admits, total, checkpoint1Decisions } = await readJsonlAdmits(path);

  expect(admits).toEqual([admitA, admitSuspect]);
  // Four non-blank lines; the two blank/whitespace lines are not counted.
  expect(total).toBe(4);
  expect(checkpoint1Decisions).toEqual([{ selSongNo: suspect, decision: 'admit' }]);
});

it('returns empty results for an all-blank log', async () => {
  const path = writeLog('blank.jsonl', ['', '   ', '']);
  const { admits, total, checkpoint1Decisions } = await readJsonlAdmits(path);
  expect(admits).toEqual([]);
  expect(total).toBe(0);
  expect(checkpoint1Decisions).toEqual([]);
});

it('throws on a malformed JSON line (no silent skip)', async () => {
  const path = join(dir, 'bad.jsonl');
  writeFileSync(
    path,
    `${JSON.stringify({ selSongNo: '1', decision: 'admit' })}\nnot json\n`,
    'utf8',
  );
  await expect(readJsonlAdmits(path)).rejects.toThrow();
});
