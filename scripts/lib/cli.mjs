/**
 * Shared CLI helpers for scripts/*.mjs.
 *
 * Exports:
 *   isCliInvocation(importMetaUrl)
 *     Realpath-hardened "am I the entrypoint?" check. Same pattern as
 *     replay-merger.mjs: Node realpaths the ESM main module, so when a
 *     script is invoked through a symlinked path `import.meta.url` would
 *     NOT equal pathToFileURL(process.argv[1]) and a plain URL comparison
 *     would silently no-op (exit 0 without running) — the worst failure
 *     mode for data tooling. Compare realpaths instead; fall back to the
 *     URL comparison if realpathSync fails (e.g. argv[1] not on disk).
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @param {string} importMetaUrl - the caller's `import.meta.url`
 * @returns {boolean} true when the caller is the process entrypoint
 */
export function isCliInvocation(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(importMetaUrl) === realpathSync(process.argv[1]);
  } catch {
    return importMetaUrl === pathToFileURL(process.argv[1]).href;
  }
}
