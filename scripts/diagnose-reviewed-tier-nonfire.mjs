#!/usr/bin/env node
/**
 * Diagnostic (C-blocker) — why some reviewed Tier E/F pairs (#163) do not fire
 * at v24 re-merge even though the pair exists and the target row is clean.
 *
 * ROOT CAUSE (confirmed by local repro): the reviewed tiers resolve BOTH the
 * target and the joysound via `singletonVendorIndex` — only union-find
 * SINGLETONS are indexed — and Tier F additionally requires the joysound-side
 * row to be joy-only (or carry an explicitly registered extra provider). Tiers
 * B/C/D run BEFORE E/F, so when an earlier tier already merges the joysound into
 * a cluster (e.g. Tier B via a same-title+artist tj/blog twin) OR the joysound
 * row natively carries a tj/ky number, the reviewed pair goes inert. This is the
 * reviewed-tier analog of the audit-A Phase 1b singleton constraint.
 *
 * This tool runs the REAL mergeRecords on the given corpus, then classifies EACH
 * reviewed Tier E/F pair as fired / un-fired, and buckets the un-fired by cause:
 *   - fired                    — target row and joysound end up in ONE record.
 *   - joy-absent               — no record carries the pair's joysound number.
 *   - target-absent            — no record carries the pair's tj/ky number.
 *   - joy-native-multivendor   — the RAW joysound row already carried another
 *                                vendor number (Case C): joy-side shape rejects
 *                                it (no extra-provider). Fixable by registering
 *                                the extra provider.
 *   - joy-merged-into-cluster  — the raw joysound row was joy-only but an earlier
 *                                tier merged it into a multi-vendor cluster
 *                                (Case B): the singleton requirement blocks the
 *                                reviewed attach. Fixable only by relaxing the
 *                                joy-side singleton requirement for reviewed tiers.
 *   - target-nonsingleton      — the target row itself got merged by an earlier
 *                                tier (rare; target no longer a singleton).
 *   - both-single-unfired      — both look clean yet no union: UNEXPECTED, a real
 *                                bug to escalate.
 *
 * REPORT-ONLY. Needs the crawler dist (mergeRecords + reviewed tables):
 *   corepack pnpm --filter @karaoke/crawler build
 * MEMORY: runs mergeRecords on the full corpus; use a high heap:
 *   node --max-old-space-size=8192 scripts/diagnose-reviewed-tier-nonfire.mjs \
 *     --corpus data/v24/pre-merge-corpus.json --out data/v24/reviewed-nonfire.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const MERGE_JS = resolve(REPO_ROOT, 'packages/crawler/dist/merge.js');
const REVIEWED_JS = resolve(REPO_ROOT, 'packages/crawler/dist/reviewedMergePairs.js');

export const USAGE =
  'usage: node [--max-old-space-size=8192] scripts/diagnose-reviewed-tier-nonfire.mjs --corpus <corpus.json> --out <report.json> [--samples N]';

export function parseArgs(argv) {
  const args = { corpus: null, out: null, samples: 15, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') args.corpus = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--samples') args.samples = Number(argv[++i]);
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown arg: ${a}\n${USAGE}`);
  }
  if (!args.help && (!args.corpus || !args.out))
    throw new Error(`--corpus and --out required\n${USAGE}`);
  return args;
}

export async function loadDeps() {
  for (const p of [MERGE_JS, REVIEWED_JS]) {
    if (!existsSync(p)) {
      throw new Error(
        `missing crawler dist at ${p}\n  Run \`corepack pnpm --filter @karaoke/crawler build\` first.`,
      );
    }
  }
  const { mergeRecords } = await import(pathToFileURL(MERGE_JS).href);
  const { REVIEWED_TIER_E_JOYS_BY_TJ, REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER } = await import(
    pathToFileURL(REVIEWED_JS).href
  );
  return { mergeRecords, REVIEWED_TIER_E_JOYS_BY_TJ, REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER };
}

/** Flatten the reviewed tables into `{ tier, vendor, number, joysound }` pairs. */
export function reviewedPairs(deps) {
  const pairs = [];
  for (const [tj, joys] of deps.REVIEWED_TIER_E_JOYS_BY_TJ) {
    for (const j of joys) pairs.push({ tier: 'E', vendor: 'tj', number: tj, joysound: j });
  }
  for (const [key, joys] of deps.REVIEWED_TIER_F_JOYS_BY_VENDOR_NUMBER) {
    const [vendor, number] = key.split(':');
    for (const j of joys) pairs.push({ tier: 'F', vendor, number, joysound: j });
  }
  return pairs;
}

const otherVendorsPresent = (kn, vendor) => {
  const others = [];
  for (const v of ['tj', 'ky', 'joysound']) {
    if (v === vendor) continue;
    if (kn?.[v] != null) others.push(v);
  }
  return others;
};

/**
 * Classify every reviewed pair against the merged corpus. `merged` is the
 * mergeRecords output; `rawByJoysound` maps a joysound number to its RAW
 * (pre-merge) record so we can tell a native multi-vendor joy row (Case C) from
 * one an earlier tier merged into a cluster (Case B).
 */
export function classify(pairs, merged, rawByJoysound, samples) {
  const mergedByJoysound = new Map();
  const mergedByVendor = { tj: new Map(), ky: new Map() };
  for (const r of merged) {
    const kn = r.karaoke_numbers ?? {};
    if (kn.joysound != null) mergedByJoysound.set(kn.joysound, r);
    if (kn.tj != null) mergedByVendor.tj.set(kn.tj, r);
    if (kn.ky != null) mergedByVendor.ky.set(kn.ky, r);
  }

  const buckets = {
    fired: [],
    'joy-absent': [],
    'target-absent': [],
    'joy-native-multivendor': [],
    'joy-merged-into-cluster': [],
    'target-nonsingleton': [],
    'both-single-unfired': [],
  };
  const put = (b, p, extra) => {
    if (buckets[b].length < samples) buckets[b].push({ ...p, ...extra });
  };
  const counts = Object.fromEntries(Object.keys(buckets).map((k) => [k, 0]));

  for (const p of pairs) {
    const joyRec = mergedByJoysound.get(p.joysound);
    const targetRec = mergedByVendor[p.vendor].get(p.number);
    let bucket;
    if (!joyRec) bucket = 'joy-absent';
    else if (!targetRec) bucket = 'target-absent';
    else if (joyRec === targetRec) bucket = 'fired';
    else {
      const rawJoy = rawByJoysound.get(p.joysound);
      const rawOthers = otherVendorsPresent(rawJoy?.karaoke_numbers, 'joysound');
      const mergedJoyOthers = otherVendorsPresent(joyRec.karaoke_numbers, 'joysound');
      const targetOthers = otherVendorsPresent(targetRec.karaoke_numbers, p.vendor);
      // The joysound row was absorbed into a larger cluster whose survivor id is
      // a different record — including a joysound↔joysound automatic merge (same
      // title+artist, two JOYSOUND numbers), which leaves no extra tj/ky cell to
      // detect. Treat it as the joy-merged-into-cluster (Case B) family.
      const joyAbsorbed = rawJoy !== undefined && rawJoy.id !== joyRec.id;
      if (rawOthers.length > 0) bucket = 'joy-native-multivendor';
      else if (mergedJoyOthers.length > 0 || joyAbsorbed) bucket = 'joy-merged-into-cluster';
      else if (targetOthers.length > 0) bucket = 'target-nonsingleton';
      else bucket = 'both-single-unfired';
    }
    counts[bucket] += 1;
    put(bucket, p, { targetId: targetRec?.id ?? null, joyId: joyRec?.id ?? null });
  }
  return { counts, samples: buckets };
}

export function buildReport(pairs, merged, corpus, samples) {
  const rawByJoysound = new Map();
  for (const r of corpus) {
    const j = r.karaoke_numbers?.joysound;
    if (j != null) rawByJoysound.set(j, r);
  }
  const { counts, samples: sampleBuckets } = classify(pairs, merged, rawByJoysound, samples);
  const byTier = { E: { total: 0, fired: 0 }, F: { total: 0, fired: 0 } };
  for (const p of pairs) byTier[p.tier].total += 1;
  const firedByTier = { E: 0, F: 0 };
  // recompute fired-by-tier for the summary
  const mergedByJoysound = new Map();
  const mergedByVendor = { tj: new Map(), ky: new Map() };
  for (const r of merged) {
    const kn = r.karaoke_numbers ?? {};
    if (kn.joysound != null) mergedByJoysound.set(kn.joysound, r);
    if (kn.tj != null) mergedByVendor.tj.set(kn.tj, r);
    if (kn.ky != null) mergedByVendor.ky.set(kn.ky, r);
  }
  for (const p of pairs) {
    const j = mergedByJoysound.get(p.joysound);
    const t = mergedByVendor[p.vendor].get(p.number);
    if (j && t && j === t) firedByTier[p.tier] += 1;
  }
  byTier.E.fired = firedByTier.E;
  byTier.F.fired = firedByTier.F;
  return { totalReviewedPairs: pairs.length, byTier, counts, samples: sampleBuckets };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const corpusPath = resolve(args.corpus);
  if (!existsSync(corpusPath)) {
    console.error(`ERROR: corpus not found: ${corpusPath}`);
    process.exitCode = 2;
    return;
  }
  const deps = await loadDeps();
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const { records: merged } = deps.mergeRecords(corpus);
  const pairs = reviewedPairs(deps);
  const report = buildReport(pairs, merged, corpus, args.samples);

  writeJsonAtomic(resolve(args.out), report, { indent: 2, trailingNewline: true });
  console.log(
    `[diag-reviewed] pairs ${report.totalReviewedPairs} | Tier E ${report.byTier.E.fired}/${report.byTier.E.total} fired | Tier F ${report.byTier.F.fired}/${report.byTier.F.total} fired`,
  );
  for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k}: ${v}`);
  console.log(`[diag-reviewed] wrote ${args.out}`);
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
