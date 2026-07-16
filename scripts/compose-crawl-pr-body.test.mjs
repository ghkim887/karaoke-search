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

  it('never throws on valid-JSON but wrong-shape rows (null line + non-array matched_chars)', () => {
    // Both lines parse fine but neither is a well-formed suspect: the `null`
    // line is skipped, and the object with a string matched_chars must render
    // an empty matched cell instead of throwing on `.join`.
    const path = writeSuspects('shape.jsonl', [
      'null',
      suspectLine({ id: 'tj-9', title_primary: 'T', artist_primary: 'A', matched_chars: '你' }),
    ]);
    let body;
    expect(() => {
      body = composePrBody(join(dir, 'nope.json'), undefined, path);
    }).not.toThrow();
    expect(body).toContain(HEADING);
    expect(body).toContain('1 suspect row:');
    expect(body).toContain('| tj-9 | T | A |  |');
  });

  it('appends the audit section AFTER the parity delta when both are present', () => {
    const delta = '## Search-parity baseline delta\n\nbody\n';
    const suspects = writeSuspects('s.jsonl', []);
    const body = composePrBody(join(dir, 'nope.json'), writeText('delta.md', delta), suspects);
    expect(body.indexOf('## Search-parity baseline delta')).toBeLessThan(body.indexOf(HEADING));
  });
});

describe('TJ filter attribution section (2026-07-12, report-only)', () => {
  const HEADING = '### TJ filter attribution';

  // Write a JSONL decision log named `name` into the temp dir; return nothing —
  // the section reads by fixed filename from the DIR (the composer's 4th arg).
  function writeDecisions(name, rows) {
    writeText(name, rows.length === 0 ? '' : `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  // A dir with all three decision files present (the CI-complete case).
  function writeFullDir() {
    writeDecisions('tj-filter.jsonl', [
      {
        tj: '1',
        title: 't1',
        artist: 'YOASOBI',
        decision: 'admit',
        step: 'jpn-admit-artist',
        reason: 'artist',
      },
      {
        tj: '2',
        title: 't2',
        artist: 'UnknownA',
        decision: 'admit',
        step: 'jpn-admit-pro',
        reason: 'pro',
      },
      {
        tj: '3',
        title: 't3',
        artist: '방탄소년단',
        decision: 'drop',
        step: 'drop-list-reject',
        reason: 'korean-drop-list',
      },
      {
        tj: '4',
        title: 't4',
        artist: 'UnknownB',
        decision: 'drop',
        step: null,
        reason: 'no-admit-path',
      },
    ]);
    writeDecisions('drop-kpop-leaks.jsonl', [
      {
        id: 'tj-5',
        title: 't5',
        artist: 'BTS',
        decision: 'drop',
        step: 'drop-artist-leaks',
        reason: 'korean-drop-list',
      },
    ]);
    writeDecisions('drop-cpop-leaks.jsonl', [
      {
        id: 'tj-6',
        title: 't6',
        artist: 'BEYOND',
        decision: 'drop',
        step: 'drop-artist-leaks',
        reason: 'chinese-drop-list',
      },
    ]);
  }

  it('omits the section when no decisions dir is passed (byte-parity with old behavior)', () => {
    expect(composePrBody(join(dir, 'nope.json'), undefined, undefined, undefined)).toBe(
      BOILERPLATE,
    );
  });

  it('renders totals and the aggregate reason table from all three files', () => {
    writeFullDir();
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain(HEADING);
    expect(body).toContain('Kept 2 / dropped 2 (from `tj-filter.jsonl`).');
    expect(body).toContain('| step | decision | reason | count |');
    expect(body).toContain('| tj-filter | admit | artist | 1 |');
    expect(body).toContain('| tj-filter | admit | pro | 1 |');
    expect(body).toContain('| tj-filter | drop | korean-drop-list | 1 |');
    expect(body).toContain('| tj-filter | drop | no-admit-path | 1 |');
    expect(body).toContain('| drop-kpop-leaks | drop | korean-drop-list | 1 |');
    expect(body).toContain('| drop-cpop-leaks | drop | chinese-drop-list | 1 |');
    // All files present → no fail-soft note.
    expect(body).not.toContain('[!NOTE]');
  });

  it('renders "Kept 0 / dropped 0" for an all-clean crawl (empty files)', () => {
    writeDecisions('tj-filter.jsonl', []);
    writeDecisions('drop-kpop-leaks.jsonl', []);
    writeDecisions('drop-cpop-leaks.jsonl', []);
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain('Kept 0 / dropped 0 (from `tj-filter.jsonl`).');
    expect(body).toContain('No filter decisions recorded.');
    expect(body).not.toContain('[!NOTE]');
  });

  it('renders a visible note (never throws) when tj-filter.jsonl is missing', () => {
    // Dir exists (mkdtemp) but the anchor file was never written.
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain(HEADING);
    expect(body).toContain('> [!NOTE]');
    expect(body).toContain('not found');
    expect(body).toContain('does not block the crawl');
  });

  it('renders a visible note (never throws) on a malformed tj-filter.jsonl line', () => {
    writeText('tj-filter.jsonl', '{oops\n');
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain(HEADING);
    expect(body).toContain('> [!NOTE]');
    expect(body).toContain('Could not parse');
  });

  it('still renders the crawler table but appends a per-file note when a drop file is missing', () => {
    writeDecisions('tj-filter.jsonl', [
      {
        tj: '1',
        title: 't1',
        artist: 'YOASOBI',
        decision: 'admit',
        step: 'jpn-admit-artist',
        reason: 'artist',
      },
    ]);
    // drop-kpop-leaks.jsonl / drop-cpop-leaks.jsonl intentionally absent.
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain('| tj-filter | admit | artist | 1 |');
    expect(body).toContain('> [!NOTE]');
    expect(body).toContain('drop-kpop-leaks.jsonl');
    expect(body).toContain('drop-cpop-leaks.jsonl');
  });

  it('appends the TJ section AFTER the Chinese audit section when both are present', () => {
    writeFullDir();
    const suspects = writeText('s.jsonl', '');
    const body = composePrBody(join(dir, 'nope.json'), undefined, suspects, dir);
    expect(body.indexOf('### Simplified-Chinese audit')).toBeLessThan(body.indexOf(HEADING));
  });
});

describe('KY filter attribution section (2026-07-16, report-only)', () => {
  const HEADING = '### KY filter attribution';
  const writeKy = (rows) =>
    writeText(
      'ky-filter.jsonl',
      rows.length === 0 ? '' : `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  // Write the (empty) TJ-side logs so the TJ section renders note-free and does
  // not pollute a whole-body `not.toContain('[!NOTE]')` assertion about KY.
  const writeCleanTjLogs = () => {
    writeText('tj-filter.jsonl', '');
    writeText('drop-kpop-leaks.jsonl', '');
    writeText('drop-cpop-leaks.jsonl', '');
  };

  it('renders NOTHING when ky-filter.jsonl is absent (byte-parity for TJ-only dirs)', () => {
    // A dir with only a TJ log must not sprout a KY section.
    writeText('tj-filter.jsonl', '');
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).not.toContain(HEADING);
  });

  it('renders totals and the admit/drop reason table from ky-filter.jsonl', () => {
    writeCleanTjLogs(); // keep the TJ section note-free so we isolate KY
    writeKy([
      {
        ky: '20',
        title: '怪物',
        artist: 'YOASOBI',
        decision: 'admit',
        step: 'index',
        reason: 'admit-index',
      },
      {
        ky: '30',
        title: 'x',
        artist: 'YOASOBI',
        decision: 'admit',
        step: 'truncation-repair',
        reason: 'admit-detail-repaired',
      },
      {
        ky: '21',
        title: 'Dynamite',
        artist: 'BTS',
        decision: 'drop',
        step: 'drop-list',
        reason: 'drop-korean-artist',
      },
    ]);
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain(HEADING);
    expect(body).toContain('Kept 2 / dropped 1 (from `ky-filter.jsonl`).');
    expect(body).toContain('| decision | reason | count |');
    expect(body).toContain('| admit | admit-index | 1 |');
    expect(body).toContain('| admit | admit-detail-repaired | 1 |');
    expect(body).toContain('| drop | drop-korean-artist | 1 |');
    expect(body).not.toContain('[!NOTE]');
  });

  it('renders "Kept 0 / dropped 0" for an empty ky-filter.jsonl', () => {
    writeCleanTjLogs(); // keep the TJ section note-free so we isolate KY
    writeKy([]);
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain('Kept 0 / dropped 0 (from `ky-filter.jsonl`).');
    expect(body).toContain('No filter decisions recorded.');
    expect(body).not.toContain('[!NOTE]');
  });

  it('renders a visible note (never throws) on a malformed ky-filter.jsonl line', () => {
    writeText('ky-filter.jsonl', '{oops\n');
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body).toContain(HEADING);
    expect(body).toContain('> [!NOTE]');
    expect(body).toContain('Could not parse');
  });

  it('appends the KY section AFTER the TJ section when both logs are present', () => {
    writeText('tj-filter.jsonl', '');
    writeKy([]);
    const body = composePrBody(join(dir, 'nope.json'), undefined, undefined, dir);
    expect(body.indexOf('### TJ filter attribution')).toBeLessThan(body.indexOf(HEADING));
  });
});
