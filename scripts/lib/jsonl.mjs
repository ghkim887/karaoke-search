/**
 * Shared JSONL streaming reader for scripts/*.mjs.
 *
 * The JOYSOUND sweeps, the replay classifier, and the Layer-3 sampler all read
 * a large newline-delimited JSON file line-by-line (createReadStream +
 * readline, never whole-file). Only the per-line policy differs — some scripts
 * dedup, some fail fast on a bad line, some warn-and-skip. This generator owns
 * the streaming boilerplate; callers own the policy:
 *
 *   - Pass `onParseError(err, lineNo)` to warn-and-skip a malformed line (the
 *     line is not yielded). `lineNo` is the 1-based PHYSICAL line number
 *     (blank lines included), matching the fail-fast callers' numbering.
 *   - Omit `onParseError` to let JSON.parse throw the raw SyntaxError (the
 *     Layer-3 sampler relies on this).
 *
 * Blank/whitespace-only lines are always skipped and never yielded.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * Stream parsed JSON values from a JSONL file.
 *
 * @param {string} path - file to stream
 * @param {{ onParseError?: (err: unknown, lineNo: number) => void }} [opts]
 * @yields {unknown} the parsed value for each non-blank line
 */
export async function* streamJsonl(path, { onParseError } = {}) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      if (onParseError) {
        onParseError(err, lineNo);
        continue;
      }
      throw err;
    }
    yield value;
  }
}
