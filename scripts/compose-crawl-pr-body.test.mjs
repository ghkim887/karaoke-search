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

describe('simplified-Chinese audit section (2026-07-12, report-only)', () => {
  const HEADING = '### Simplified-Chinese audit';

  // JSONL line shape the audit writes: one compact object per suspect row.
  function suspectLine(fields) {
    return JSON.stringify(fields);
  }
  function writeSuspects(name, lines) {
    return writeText(name, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  }

  it('omits the audit section when no suspects path is passed (byte-parity with old behavior)', () => {
    expect(composePrBody(join(dir, 'nope.json'))).toBe(BOILERPLATE);
  });

  it('renders "0 suspects" for an all-clean corpus (empty JSONL file)', () => {
    const body = composePrBody(join(dir, 'nope.json'), undefined, writeSuspects('s.jsonl', []));
    expect(body).toBe(`${BOILERPLATE}\n${HEADING}\n\n0 suspects.\n`);
  });

  it('renders the count and a row table when there are suspects', () => {
    const path = writeSuspects('s.jsonl', [
      suspectLine({
        id: 'tj-42',
        title_primary: '明天你是否依然爱我',
        artist_primary: '童安格',
        matched_chars: ['你', '爱'],
        matched_fields: ['title_primary'],
      }),
    ]);
    const body = composePrBody(join(dir, 'nope.json'), undefined, path);
    expect(body).toContain(HEADING);
    expect(body).toContain('1 suspect row:');
    expect(body).toContain('| id | title | artist | matched chars |');
    expect(body).toContain('| tj-42 | 明天你是否依然爱我 | 童安格 | 你 爱 |');
  });

  it('caps the table at 20 rows and says how many are shown', () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      suspectLine({
        id: `tj-${i}`,
        title_primary: `T${i}`,
        artist_primary: `A${i}`,
        matched_chars: ['爱'],
        matched_fields: ['title_primary'],
      }),
    );
    const body = composePrBody(join(dir, 'nope.json'), undefined, writeSuspects('s.jsonl', lines));
    expect(body).toContain('25 suspect rows (showing first 20):');
    expect(body).toContain('| tj-19 |');
    expect(body).not.toContain('| tj-20 |');
  });

  it('escapes pipe characters so a title cannot break out of the table cell', () => {
    const path = writeSuspects('s.jsonl', [
      suspectLine({
        id: 'tj-1',
        title_primary: 'a|b',
        artist_primary: 'c',
        matched_chars: ['爱'],
        matched_fields: ['title_primary'],
      }),
    ]);
    const body = composePrBody(join(dir, 'nope.json'), undefined, path);
    expect(body).toContain('| a\\|b |');
  });

  it('renders a visible note (never throws) when the suspects file is missing', () => {
    const body = composePrBody(join(dir, 'nope.json'), undefined, join(dir, 'absent.jsonl'));
    expect(body).toContain(HEADING);
    expect(body).toContain('> [!NOTE]');
    expect(body).toContain('not found');
    expect(body).toContain('does not block the crawl');
  });

  it('renders a visible note (never throws) on a malformed JSONL line', () => {
    const body = composePrBody(
      join(dir, 'nope.json'),
      undefined,
      writeText('bad.jsonl', '{oops\n'),
    );
    expect(body).toContain(HEADING);
    expect(body).toContain('> [!NOTE]');
    expect(body).toContain('Could not parse');
  });

  it('appends the audit section AFTER the parity delta when both are present', () => {
    const delta = '## Search-parity baseline delta\n\nbody\n';
    const suspects = writeSuspects('s.jsonl', []);
    const body = composePrBody(join(dir, 'nope.json'), writeText('delta.md', delta), suspects);
    expect(body.indexOf('## Search-parity baseline delta')).toBeLessThan(body.indexOf(HEADING));
  });
});
