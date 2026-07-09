// Tests for scripts/compose-crawl-pr-body.mjs — the weekly-crawl PR-body
// composer. Pins the original conflicts-summary behavior (boilerplate / section
// / fail-closed on a malformed total) AND the 2026-07-10 parity-delta append.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composePrBody } from './compose-crawl-pr-body.mjs';

const BOILERPLATE = 'Automated crawl output. See workflow run for logs.\n';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'compose-pr-body-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value), 'utf8');
  return path;
}

function writeText(name, text) {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

describe('conflicts section (unchanged behavior)', () => {
  it('returns boilerplate only when the conflicts file is missing', () => {
    expect(composePrBody(join(dir, 'nope.json'))).toBe(BOILERPLATE);
  });

  it('returns boilerplate only when total is 0', () => {
    expect(composePrBody(writeJson('c.json', { total: 0, sample: [] }))).toBe(BOILERPLATE);
  });

  it('renders the conflicts section when total > 0', () => {
    const path = writeJson('c.json', {
      total: 2,
      sample: [
        {
          field: 'title',
          values: [
            { source: 'tj', value: 'A' },
            { source: 'ky', value: 'B' },
          ],
          winner: 'A',
          cluster_key: 'k1',
        },
      ],
    });
    const body = composePrBody(path);
    expect(body).toContain('## Merge conflicts during dedup');
    expect(body).toContain('- Total: 2');
    expect(body).toContain('  - title: tj=A, ky=B -> winner: A (cluster_key=k1)');
  });

  it('throws (fail-closed) on a non-integer total', () => {
    expect(() => composePrBody(writeJson('c.json', { total: 'x', sample: [] }))).toThrow(
      /"total" is not an integer/,
    );
  });
});

describe('parity-delta section (2026-07-10)', () => {
  it('omits the parity section when no delta path is passed (byte-parity with old behavior)', () => {
    expect(composePrBody(join(dir, 'nope.json'))).toBe(BOILERPLATE);
  });

  it('appends the delta contents after the boilerplate when there are no conflicts', () => {
    const delta = '## Search-parity baseline delta\n\nNo per-query drift...\n';
    const body = composePrBody(join(dir, 'nope.json'), writeText('delta.md', delta));
    expect(body).toBe(`${BOILERPLATE}\n${delta}`);
  });

  it('appends the delta AFTER the conflicts section when both are present', () => {
    const conflicts = writeJson('c.json', {
      total: 1,
      sample: [
        { field: 'artist', values: [{ source: 'tj', value: 'Z' }], winner: 'Z', cluster_key: 'k' },
      ],
    });
    const delta = '## Search-parity baseline delta\n\nbody\n';
    const body = composePrBody(conflicts, writeText('delta.md', delta));
    expect(body.indexOf('## Merge conflicts during dedup')).toBeLessThan(
      body.indexOf('## Search-parity baseline delta'),
    );
    expect(body.endsWith(delta)).toBe(true);
  });

  it('throws (fail-closed) when a delta path is passed but the file is missing', () => {
    expect(() => composePrBody(join(dir, 'nope.json'), join(dir, 'absent-delta.md'))).toThrow(
      /parity delta file not found/,
    );
  });
});
