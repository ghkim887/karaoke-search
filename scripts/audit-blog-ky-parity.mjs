#!/usr/bin/env node
/**
 * READ-ONLY, REPORT-ONLY blog↔KY parity audit (R5 KY adapter, D7).
 *
 * Question this answers, over the MERGED corpus: of the KY catalog numbers the
 * blog corpus claims, how many does the live KY crawl now cover?
 *
 * How it reads the answer from the merged corpus (no replay needed):
 *   - A blog row that claims `ky=X` Tier-A-unions with the live `ky-X` record
 *     when one exists; because `ky` (SOURCE_RANK 4) outranks `blog` (5), the
 *     merged cluster survives under the stable `ky-X` id — the blog row
 *     GRADUATED. So a residual standalone `blog-*` record still carrying a `ky`
 *     number means that number is NOT in the live KY corpus (delisted song,
 *     blog typo, or an en/kr-tab-only number the jp walk cannot reach).
 *   - Live KY coverage is the set of `ky` numbers on `ky-*` records.
 *
 * This NEVER gates: it always exits 0 when it can read the corpus (report-only,
 * per the "first soak" policy — a ≥95% parity threshold is enforced later, once
 * soaked). It does NOT mutate the corpus, the filter chain, or crawl.yml.
 *
 * NOTE on the covered-ratio: computing the true "% of blog claims covered"
 * needs the PRE-crawl blog-ky total (matched claims graduate away, so the
 * merged corpus alone cannot recount them). Until the crawl resumes and a
 * baseline exists, this reports the STATIC counts (residual blog claims + live
 * KY coverage); the owner reads the ratio against a baseline during the soak.
 *
 * Output
 * ------
 *   <out>/blog-ky-residuals.jsonl   one object per residual blog ky claim:
 *                                   { ky, id, title_primary, artist_primary }.
 *                                   Written even when empty.
 *   stdout                          summary counts.
 *
 * Usage
 * -----
 *   node scripts/audit-blog-ky-parity.mjs                 # committed baseline
 *   node scripts/audit-blog-ky-parity.mjs <corpus.json>   # candidate/full corpus
 *   node scripts/audit-blog-ky-parity.mjs --out <dir>
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';
import { loadCorpus } from './lib/corpus.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DEFAULT_CORPUS = resolve(REPO_ROOT, 'apps/web/public/data/songs.json');
// Default artifact dir: gitignored so a bare invocation never stages output.
const DEFAULT_OUT_DIR = resolve(REPO_ROOT, 'scripts/data/audit-blog-ky-parity');
const JSONL_NAME = 'blog-ky-residuals.jsonl';

export const USAGE = 'usage: node scripts/audit-blog-ky-parity.mjs [<corpus.json>] [--out <dir>]';

/** Parse CLI args. Throws on unknown flags, missing values, or extra args. */
export function parseArgs(argv) {
  const parsed = { corpusPath: null, outDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a directory value');
      parsed.outDir = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (parsed.corpusPath === null) {
      parsed.corpusPath = arg;
    } else {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
  }
  return parsed;
}

/**
 * Compute the parity report from a MERGED record list. Pure.
 *
 * Returns `{ residuals, summary }`:
 *   residuals  one `{ ky, id, title_primary, artist_primary }` per standalone
 *              `blog-*` record carrying a ky number (corpus order, stable).
 *   summary    { scanned, liveKyCount, blogResidualKyCount } where liveKyCount
 *              is the distinct ky on `ky-*` records (live coverage) and
 *              blogResidualKyCount the distinct residual blog ky claims.
 */
export function computeParity(records) {
  const liveKy = new Set();
  const residualKy = new Set();
  const residuals = [];
  for (const r of records) {
    const id = typeof r?.id === 'string' ? r.id : '';
    const ky = r?.karaoke_numbers?.ky;
    if (ky === null || ky === undefined) continue;
    if (id.startsWith('ky-')) {
      liveKy.add(ky);
    } else if (id.startsWith('blog-')) {
      residualKy.add(ky);
      residuals.push({
        ky,
        id,
        title_primary: typeof r?.title_primary === 'string' ? r.title_primary : '',
        artist_primary: typeof r?.artist_primary === 'string' ? r.artist_primary : '',
      });
    }
  }
  return {
    residuals,
    summary: {
      scanned: records.length,
      liveKyCount: liveKy.size,
      blogResidualKyCount: residualKy.size,
    },
  };
}

/** Serialise residuals as JSONL (one compact JSON object per line). */
export function buildJsonl(residuals) {
  return residuals.map((row) => JSON.stringify(row)).join('\n');
}

/**
 * Orchestrate: load corpus, compute, write the JSONL, print the summary.
 * Returns 0 on success (report-only, never gated), 2 on a missing corpus.
 */
export function runAudit({ corpusPath, outDir, log = console }) {
  const resolvedCorpus = resolve(corpusPath ?? DEFAULT_CORPUS);
  if (!existsSync(resolvedCorpus)) {
    log.error(`ERROR: missing corpus at ${resolvedCorpus}`);
    return 2;
  }
  const resolvedOut = resolve(outDir ?? DEFAULT_OUT_DIR);
  const jsonlPath = resolve(resolvedOut, JSONL_NAME);

  const corpus = loadCorpus(resolvedCorpus);
  const { residuals, summary } = computeParity(corpus);

  const jsonl = buildJsonl(residuals);
  writeTextAtomic(jsonlPath, jsonl === '' ? '' : `${jsonl}\n`);

  log.log(`corpus: ${resolvedCorpus}`);
  log.log(`rows scanned: ${summary.scanned}`);
  log.log(`live KY numbers (ky-* records): ${summary.liveKyCount}`);
  log.log(
    `blog residual KY claims (blog-* rows, NOT covered by live KY): ${summary.blogResidualKyCount}`,
  );
  if (summary.liveKyCount === 0) {
    log.log(
      'note: no live KY records yet (KY crawl not run / disabled) — every blog KY claim is residual by construction. Report-only.',
    );
  }
  log.log(`wrote ${jsonlPath}`);
  return 0;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  process.exitCode = runAudit({ corpusPath: args.corpusPath, outDir: args.outDir });
}

if (isCliInvocation(import.meta.url)) {
  main();
}
