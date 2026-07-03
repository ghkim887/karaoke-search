#!/usr/bin/env node
/**
 * Behavior-parity harness: run the CANONICAL TS artist splitter over the shared
 * fixture and print its results as JSON on stdout.
 *
 * This is the Node half of the TS<->Python splitter parity gate (T0-2). The
 * Python half (`scripts/test_splitter_behavior_parity.py`) shells out to this
 * harness, then compares the drop-check keys emitted here against the keys its
 * own `artist_components_for_drop_check` mirror produces for the same inputs.
 *
 * Why a separate harness instead of hand-mirroring the TS output in Python:
 * `scripts/drop-artist-leaks.mjs` already establishes the pattern of importing
 * the canonical `splitArtistCollab` / `normalizeForMatch` straight from the
 * built crawler dist (Python cannot import the TS source). Reusing that exact
 * import means the parity test compares against the SAME code the crawl-time
 * parser and the corpus cleanup pass run — not a copy that could itself drift.
 *
 * BUILD PREREQUISITE: `corepack pnpm --filter @karaoke/crawler build` must have
 * run first so `packages/crawler/dist/clustering.js` exists. A missing dist is
 * a hard error (exit 2) with a build hint — never a silent skip. In CI the
 * `pnpm build` step runs before the Python test step, so the dist is always
 * present by the time this harness is invoked.
 *
 * Output schema (stdout, JSON):
 *   {
 *     "results": [
 *       { "input": "<fixture input>",
 *         "components": ["<surface component>", ...],   // splitArtistCollab output, in order
 *         "keys": ["<normalized key>", ...] },          // sorted unique normalizeForMatch(component), '' dropped
 *       ...
 *     ]
 *   }
 * `results` is index-aligned with the fixture `cases` array.
 *
 * Usage:
 *   node scripts/splitter_parity_harness.mjs [path/to/fixture.json]
 * Fixture path defaults to scripts/fixtures/splitter_parity_cases.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CLUSTERING_DIST = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
const DEFAULT_FIXTURE = resolve(HERE, 'fixtures/splitter_parity_cases.json');

async function main() {
  const fixturePath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FIXTURE;

  if (!existsSync(CLUSTERING_DIST)) {
    // Hard error, not a skip: a missing dist means the caller forgot to build.
    // Same build hint drop-artist-leaks.mjs uses so the fix is obvious.
    throw new Error(
      `missing crawler dist at ${CLUSTERING_DIST}\n` +
        '  Run `corepack pnpm --filter @karaoke/crawler build` first.',
    );
  }
  if (!existsSync(fixturePath)) {
    throw new Error(`fixture not found: ${fixturePath}`);
  }

  const { normalizeForMatch, splitArtistCollab } = await import(
    pathToFileURL(CLUSTERING_DIST).href
  );

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const cases = Array.isArray(fixture.cases) ? fixture.cases : [];

  const results = cases.map((entry) => {
    const input = typeof entry === 'string' ? entry : entry.input;
    const components = splitArtistCollab(input);
    // The drop filter (isArtistDropped in drop-artist-leaks.mjs) only ever
    // consumes normalizeForMatch(component); the set of those keys IS the
    // observable behavior. Dedupe + sort so the comparison is order-invariant.
    const keys = [...new Set(components.map((c) => normalizeForMatch(c)).filter((k) => k !== ''))].sort();
    return { input, components, keys };
  });

  process.stdout.write(JSON.stringify({ results }));
}

main().catch((err) => {
  console.error(`splitter-parity-harness failed: ${err.message}`);
  process.exit(2);
});
