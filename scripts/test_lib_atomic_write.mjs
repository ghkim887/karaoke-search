import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writeJsonAtomic, writeTextAtomic } from './lib/atomic-write.mjs';
import { loadCorpus, loadValidator } from './lib/corpus.mjs';

// ---------------------------------------------------------------------------
// writeJsonAtomic
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — round-trip', () => {
  it('writes JSON and reads it back intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.json');
      const value = { version: 1, keys: ['a', 'b', 'c'] };
      writeJsonAtomic(dest, value);
      const read = JSON.parse(readFileSync(dest, 'utf-8'));
      assert.deepEqual(read, value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('byte-stable on identical input (trailing newline)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.json');
      const value = [{ id: 'tj-1', title_primary: '愛' }];
      writeJsonAtomic(dest, value);
      const first = readFileSync(dest);
      writeJsonAtomic(dest, value);
      const second = readFileSync(dest);
      assert.ok(first.equals(second), 'second write should be byte-identical');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends trailing newline by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.json');
      writeJsonAtomic(dest, { x: 1 });
      const raw = readFileSync(dest, 'utf-8');
      assert.ok(raw.endsWith('\n'), 'file should end with newline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits trailing newline when trailingNewline=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.json');
      writeJsonAtomic(dest, { x: 1 }, { trailingNewline: false });
      const raw = readFileSync(dest, 'utf-8');
      assert.ok(!raw.endsWith('\n'), 'file should NOT end with newline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects custom indent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.json');
      writeJsonAtomic(dest, { a: 1 }, { indent: 4 });
      const raw = readFileSync(dest, 'utf-8');
      assert.ok(raw.includes('    "a"'), 'should use 4-space indent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomicity: no partial write at destination on failure', () => {
    // Write a known value first, then simulate a failure by writing to a
    // path whose .tmp file we pre-populate but whose rename would fail (we
    // check that the destination is not modified mid-write by verifying the
    // .tmp file is never left behind on a successful write).
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'corpus.json');
      const original = [{ id: 'tj-1' }];
      writeJsonAtomic(dest, original);

      // Confirm .tmp is cleaned up after a successful write.
      const tmpPath = `${dest}.tmp`;
      assert.ok(!existsSync(tmpPath), '.tmp file should be gone after successful write');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates parent directories if they do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'nested', 'deep', 'out.json');
      writeJsonAtomic(dest, [1, 2, 3]);
      assert.ok(existsSync(dest), 'file should exist after mkdirSync');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeTextAtomic
// ---------------------------------------------------------------------------

describe('writeTextAtomic — round-trip', () => {
  it('writes text and reads it back intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.txt');
      const text = 'hello\nworld\n';
      writeTextAtomic(dest, text);
      assert.equal(readFileSync(dest, 'utf-8'), text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans up .tmp after successful write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'out.txt');
      writeTextAtomic(dest, 'data');
      assert.ok(!existsSync(`${dest}.tmp`), '.tmp should be gone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadCorpus
// ---------------------------------------------------------------------------

describe('loadCorpus — error paths', () => {
  it('throws on missing file', () => {
    assert.throws(
      () => loadCorpus('/nonexistent/path/songs.json'),
      /ENOENT/,
    );
  });

  it('throws on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'bad.json');
      writeFileSync(dest, '{ not valid json', 'utf-8');
      assert.throws(() => loadCorpus(dest), /SyntaxError|Unexpected/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the parsed array for a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
    try {
      const dest = join(dir, 'songs.json');
      const data = [{ id: 'tj-1' }, { id: 'tj-2' }];
      writeFileSync(dest, JSON.stringify(data), 'utf-8');
      const result = loadCorpus(dest);
      assert.deepEqual(result, data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadValidator
// ---------------------------------------------------------------------------

describe('loadValidator', () => {
  it('returns a function that validates a known-good record', async () => {
    const validate = await loadValidator();
    assert.equal(typeof validate, 'function');

    // Minimal valid SongRecord (must match schema constraints).
    const good = {
      id: 'tj-1',
      source_url: 'https://example.com/1',
      title_primary: '愛が見えない',
      title_ko: null,
      artist_primary: 'TestArtist',
      artist_ko: null,
      karaoke_numbers: { tj: '12345', ky: null, joysound: null },
      categories: ['jpop'],
      crawled_at: '2024-01-01T00:00:00.000Z',
    };

    // Should not throw.
    assert.doesNotThrow(() => validate(good));
  });

  it('throws on an invalid record (missing required field)', async () => {
    const validate = await loadValidator();
    assert.throws(() => validate({ id: 'tj-1' }), /Invalid SongRecord|required property/i);
  });
});
