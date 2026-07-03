/**
 * Shared write-stream helpers for scripts/*.mjs.
 *
 * The JOYSOUND sweeps and the replay classifier append millions of lines to a
 * write stream and must honor backpressure (a naive fire-and-forget
 * `stream.write()` loop buffers the whole output in memory). These wrap the two
 * recurring patterns.
 */

/**
 * Write `text` to `stream`, awaiting `drain` when the internal buffer is full.
 * Returns a resolved promise when the write was accepted synchronously.
 *
 * @param {import('node:stream').Writable} stream
 * @param {string} text
 * @returns {Promise<void>}
 */
export function writeLineBackpressured(stream, text) {
  return stream.write(text)
    ? Promise.resolve()
    : new Promise((resolve) => stream.once('drain', resolve));
}

/**
 * Close a write stream, surfacing any flush error as a rejection.
 *
 * @param {import('node:stream').Writable} stream
 * @returns {Promise<void>}
 */
export function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}
