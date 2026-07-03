// Tests for scripts/lib/jsonl.mjs — the shared JSONL streaming reader. The
// JOYSOUND sweeps, the replay classifier, and the Layer-3 sampler all read a
// large newline-delimited JSON file through this generator; only the per-line
// policy (warn-and-skip vs fail-fast vs dedup) differs and is supplied by the
// caller. These tests pin the parse + line-numbering + error-routing contract
// those callers depend on.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { streamJsonl } from './lib/jsonl.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lib-jsonl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name, text) {
  const p = join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

async function collect(iter) {
  const out = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('streamJsonl', () => {
  it('yields the parsed value for each non-blank line, in order', async () => {
    const p = write('in.jsonl', '{"a":1}\n{"a":2}\n{"a":3}\n');
    expect(await collect(streamJsonl(p))).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('skips blank and whitespace-only lines (never yields them)', async () => {
    const p = write('in.jsonl', '{"a":1}\n\n   \n{"a":2}\n');
    expect(await collect(streamJsonl(p))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('handles a final line without a trailing newline', async () => {
    const p = write('in.jsonl', '{"a":1}\n{"a":2}');
    expect(await collect(streamJsonl(p))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('tolerates CRLF line endings', async () => {
    const p = write('in.jsonl', '{"a":1}\r\n{"a":2}\r\n');
    expect(await collect(streamJsonl(p))).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('rethrows the raw JSON.parse error when no onParseError is supplied (fail-fast callers)', async () => {
    const p = write('in.jsonl', '{"a":1}\n{bad\n');
    await expect(collect(streamJsonl(p))).rejects.toThrow(SyntaxError);
  });

  it('routes a bad line to onParseError (skip) with the 1-based PHYSICAL line number', async () => {
    // A leading blank line makes the physical line number diverge from the
    // yielded-row count; the replay classifier fails fast with this number.
    const p = write('in.jsonl', '\n{"a":1}\n{bad\n{"a":2}\n');
    const errors = [];
    const values = await collect(
      streamJsonl(p, { onParseError: (err, lineNo) => errors.push([lineNo, err instanceof SyntaxError]) }),
    );
    expect(values).toEqual([{ a: 1 }, { a: 2 }]);
    // Line 1 blank (skipped, not counted as error), line 2 ok, line 3 bad.
    expect(errors).toEqual([[3, true]]);
  });

  it('continues after multiple bad lines when onParseError swallows them', async () => {
    const p = write('in.jsonl', '{bad1\n{"a":1}\n{bad2\n');
    const lines = [];
    const values = await collect(streamJsonl(p, { onParseError: (_e, n) => lines.push(n) }));
    expect(values).toEqual([{ a: 1 }]);
    expect(lines).toEqual([1, 3]);
  });
});
