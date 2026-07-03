// Tests for scripts/lib/stream.mjs — the shared write-stream backpressure
// helpers used by the JOYSOUND sweeps and the replay classifier when appending
// millions of lines. writeLineBackpressured must resolve synchronously on an
// accepted write and otherwise wait for `drain`; endStream must resolve on a
// clean close and reject on a flush error.

import { describe, expect, it } from 'vitest';
import { endStream, writeLineBackpressured } from './lib/stream.mjs';

/** Minimal Writable stand-in with controllable `write()` return + drain. */
function fakeStream() {
  const drainCbs = [];
  return {
    written: [],
    accept: true,
    write(text) {
      this.written.push(text);
      return this.accept;
    },
    once(event, cb) {
      if (event === 'drain') drainCbs.push(cb);
    },
    emitDrain() {
      for (const cb of drainCbs.splice(0)) cb();
    },
    end(cb) {
      this.ended = true;
      if (cb) cb(this.endErr);
    },
  };
}

describe('writeLineBackpressured', () => {
  it('resolves immediately when the write is accepted (returns true)', async () => {
    const s = fakeStream();
    s.accept = true;
    await writeLineBackpressured(s, 'line\n');
    expect(s.written).toEqual(['line\n']);
  });

  it('waits for drain when the write is buffered (returns false)', async () => {
    const s = fakeStream();
    s.accept = false;
    let settled = false;
    const p = writeLineBackpressured(s, 'line\n').then(() => {
      settled = true;
    });
    // Not resolved until drain fires.
    await Promise.resolve();
    expect(settled).toBe(false);
    s.emitDrain();
    await p;
    expect(settled).toBe(true);
  });
});

describe('endStream', () => {
  it('resolves when the stream closes cleanly', async () => {
    const s = fakeStream();
    await endStream(s);
    expect(s.ended).toBe(true);
  });

  it('rejects when end() reports a flush error', async () => {
    const s = fakeStream();
    s.endErr = new Error('flush failed');
    await expect(endStream(s)).rejects.toThrow('flush failed');
  });
});
