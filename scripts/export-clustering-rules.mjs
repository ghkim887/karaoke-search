#!/usr/bin/env node
/**
 * Export the SPLIT_RE delimiter pattern as a JSON sidecar consumable from Python.
 *
 * The TS source of truth is `packages/crawler/src/clustering.ts` which exports
 * `SPLIT_RE_SOURCE` and `SPLIT_RE_FLAGS` as named string constants. This script
 * reads those constants from the built dist (`packages/crawler/dist/clustering.js`)
 * and writes them to a sidecar JSON at
 * `packages/crawler/src/clustering-rules.json` — tracked in git, co-located
 * with the module it describes.
 *
 * Why this matters: `scripts/ingest-anisong-pdf.py` contains `_DROP_SPLIT_RE`
 * which is a superset of `SPLIT_RE` (it prepends the feat-paren alt so Python's
 * `re.split()` can capture group 1). The delimiter alternations in that regex
 * MUST stay in sync with `SPLIT_RE_SOURCE`. Previously sync was test-only; now
 * it is mechanical — Python reads the delimiter portion from this sidecar and
 * splices it into `_DROP_SPLIT_RE` at import time. Drift → sidecar diverges from
 * committed file → `git diff --exit-code` fails in CI.
 *
 * Output schema:
 *   {
 *     "version": 1,
 *     "splitterPattern": "\\s*[&＆,×｜]\\s*|\\s+with\\s+|...",
 *     "splitterFlags": "i"
 *   }
 *
 * `generatedAt` is intentionally omitted: a timestamp would dirty the working
 * tree on every build even when nothing changed. Git history is the timeline.
 *
 * Run automatically as part of `corepack pnpm --filter @karaoke/crawler build`
 * (wired into the package's `build` script). Manual invocation is also fine —
 * the script is idempotent.
 *
 * Usage:
 *   node scripts/export-clustering-rules.mjs
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DIST_MODULE = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
// Sidecar lives next to the TS source and is tracked in git. Co-locating means
// a TS edit without a sidecar regen surfaces as a one-of-two-files diff at
// code review (the staleness footgun is visible).
const OUT_PATH = resolve(REPO_ROOT, 'packages/crawler/src/clustering-rules.json');

async function main() {
  // dynamic import via file URL: the dist path is absolute on disk and not
  // resolvable as a bare specifier from this script.
  const mod = await import(pathToFileURL(DIST_MODULE).href);

  const { SPLIT_RE_SOURCE, SPLIT_RE_FLAGS } = mod;
  if (typeof SPLIT_RE_SOURCE !== 'string') {
    throw new Error(
      `SPLIT_RE_SOURCE export not found in ${DIST_MODULE} (got ${typeof SPLIT_RE_SOURCE})`,
    );
  }
  if (typeof SPLIT_RE_FLAGS !== 'string') {
    throw new Error(
      `SPLIT_RE_FLAGS export not found in ${DIST_MODULE} (got ${typeof SPLIT_RE_FLAGS})`,
    );
  }

  const sidecar = {
    version: 1,
    splitterPattern: SPLIT_RE_SOURCE,
    splitterFlags: SPLIT_RE_FLAGS,
  };

  // Atomic write: <file>.tmp then rename, matching the project's atomic-write
  // convention (see `scripts/ingest-anisong-pdf.py::_atomic_write_corpus`).
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const tmpPath = `${OUT_PATH}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, OUT_PATH);
  console.log(`wrote clustering-rules sidecar to ${OUT_PATH}`);
  console.log(`  splitterPattern: ${SPLIT_RE_SOURCE}`);
  console.log(`  splitterFlags:   ${SPLIT_RE_FLAGS}`);
}

main().catch((err) => {
  console.error('export-clustering-rules failed:', err);
  process.exit(1);
});
