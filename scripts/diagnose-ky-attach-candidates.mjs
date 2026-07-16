#!/usr/bin/env node
/**
 * Diagnostic (audit follow-up A, Phase 1b) — quantify why stripped KY rows still
 * don't merge at scale, and simulate the proposed fix directions.
 *
 * CONFIRMED root cause (local repro): the merger's Tier C/D cluster ONLY
 * union-find singletons (`groupSingletonsByKey`), and at scale a KY row's
 * JOYSOUND merge target is almost always already a NON-singleton (Tier A via a
 * blog row sharing its joysound number, or Tier B via a same-title+artist twin),
 * so the KY singleton has no singleton target to attach to — the title strip
 * (#162) makes the KEY match but no group ever forms.
 *
 * This tool runs the REAL `mergeRecords` on corpus ++ ky (the KY input should be
 * the tie-up-STRIPPED songs-ky.json, i.e. post-#162 / post apply-ky-tieup-strip),
 * then, for every residual joyless `ky-*` record, computes the proposed attach
 * key = Tier D's stripped title + Tier C's lead-component artist (the
 * combination no existing tier uses) and reports:
 *   1. hypothesis_nonsingleton — of the residual ky rows that HAVE a candidate
 *      JOYSOUND target, how many of those targets are non-singletons in the
 *      input set (the root-cause check; hypothesis ≈ ~all).
 *   2. candidateBuckets + planA — candidate-count distribution per residual ky:
 *      none (0) / unique (exactly 1 = attach target) / ambiguous (>=2 = skip,
 *      cover collision). Among unique, how many pass the vendor-number
 *      no-conflict guard => Plan A's expected merge count.
 *   3. planC — among unique, how many also pass the stronger guard (artist
 *      component overlap >= 2 OR stripped-title exact).
 *   4. samples — up to `--samples` rows per bucket for eyeball false-positive
 *      review (especially the `unique` bucket).
 *
 * REPORT-ONLY: writes only the JSON report; the proposed "attach tier" is NOT
 * implemented here — this only measures its expected effect so the owner can
 * choose a direction.
 *
 * MEMORY: runs `mergeRecords` on the full ~313k corpus; use a high heap on oci:
 *   node --max-old-space-size=8192 scripts/diagnose-ky-attach-candidates.mjs \
 *     --corpus data/current/songs.json --ky data/ky/songs-ky-stripped.json \
 *     --out data/v23/ky-attach-diagnosis.json
 *
 * BUILD PREREQUISITE: `corepack pnpm -r build` (imports the compiled merger +
 * clustering + normalize + stripContextSuffix).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write.mjs';
import { isCliInvocation } from './lib/cli.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const MERGE_JS = resolve(REPO_ROOT, 'packages/crawler/dist/merge.js');
const CLUSTERING_JS = resolve(REPO_ROOT, 'packages/crawler/dist/clustering.js');
const NORMALIZE_JS = resolve(REPO_ROOT, 'packages/crawler/dist/normalize.js');

export const USAGE =
  'usage: node [--max-old-space-size=8192] scripts/diagnose-ky-attach-candidates.mjs --corpus <full.json> --ky <ky-stripped.json> --out <report.json> [--samples N]';

// Mirror of merge.ts CLUSTER_DASH_FOLD_RE (a merge-internal const, deliberately
// NOT exported). Copied here so the diagnostic reconstructs Tier C/D keys
// byte-exactly without changing production code. Keep in sync with merge.ts.
const CLUSTER_DASH_FOLD_RE = /[-ー‐‑–—―−ｰ]/g;
const VENDORS = ['tj', 'ky', 'joysound'];
const kyNumberOf = (r) => r?.karaoke_numbers?.ky ?? null;
const joyNumberOf = (r) => r?.karaoke_numbers?.joysound ?? null;

export function parseArgs(argv) {
  const parsed = { corpus: null, ky: null, out: null, auditCsv: null, samples: 5, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--samples') {
      const v = argv[i + 1];
      if (!v) throw new Error('--samples requires a value');
      parsed.samples = Number.parseInt(v, 10);
      i += 1;
    } else if (arg === '--corpus' || arg === '--ky' || arg === '--out' || arg === '--audit-csv') {
      const v = argv[i + 1];
      if (!v) throw new Error(`${arg} requires a path value`);
      parsed[arg === '--audit-csv' ? 'auditCsv' : arg.slice(2)] = v;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

/**
 * Build the key helpers from the injected dist functions. `attachKey` is the
 * PROPOSED attach key (Tier D stripped title + Tier C lead-component artist).
 */
function makeKeys({
  normalize,
  getLeadComponent,
  splitArtistCollab,
  normalizeForMatch,
  stripContextSuffix,
}) {
  const foldDashes = (s) => s.replace(CLUSTER_DASH_FOLD_RE, '');
  const clusterKeyPart = (s) => foldDashes(normalize(s));
  const attachKey = (r) => {
    const t = clusterKeyPart(stripContextSuffix(r.title_primary).title);
    const a = foldDashes(getLeadComponent(r.artist_primary));
    return t === '' || a === '' ? null : `${t}|${a}`;
  };
  const tierBKey = (r) => `${clusterKeyPart(r.title_primary)}|${clusterKeyPart(r.artist_primary)}`;
  const componentKeys = (r) => {
    const set = new Set();
    for (const c of splitArtistCollab(r.artist_primary)) {
      const k = normalizeForMatch(c);
      if (k !== '') set.add(k);
    }
    return set;
  };
  const normStrip = (title) => normalize(stripContextSuffix(title).title);
  return { attachKey, tierBKey, componentKeys, normStrip };
}

/**
 * Build the diagnosis report. Pure given `merged` (the real mergeRecords output),
 * the ORIGINAL `corpus`/`ky` inputs, and the dist `deps`.
 */
export function buildReport(corpus, ky, merged, deps, sampleN = 5) {
  const keys = makeKeys(deps);

  // Input-set indexes: a candidate cluster is "non-singleton" if it shares a
  // vendor number OR a Tier B key with another INPUT record (i.e. it absorbed
  // >1 input during merge — the exact condition that hides it from Tier C).
  const inputs = [...corpus, ...ky];
  const byVendor = { tj: new Map(), ky: new Map(), joysound: new Map() };
  const byTierB = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of inputs) {
    for (const v of VENDORS) {
      const val = r?.karaoke_numbers?.[v];
      if (val != null) bump(byVendor[v], val);
    }
    bump(byTierB, keys.tierBKey(r));
  }
  const isNonSingleton = (rec) => {
    for (const v of VENDORS) {
      const val = rec?.karaoke_numbers?.[v];
      if (val != null && (byVendor[v].get(val) ?? 0) >= 2) return true;
    }
    return (byTierB.get(keys.tierBKey(rec)) ?? 0) >= 2;
  };

  // JOYSOUND-having merged clusters indexed by attach key (the merge targets).
  const joyByAttach = new Map();
  for (const r of merged) {
    if (joyNumberOf(r) == null) continue;
    const k = keys.attachKey(r);
    if (k === null) continue;
    if (!joyByAttach.has(k)) joyByAttach.set(k, []);
    joyByAttach.get(k).push(r);
  }

  const residual = merged.filter((r) => r.id.startsWith('ky-') && joyNumberOf(r) == null);

  const counts = { none: 0, unique: 0, ambiguous: 0 };
  const samples = { none: [], unique: [], ambiguous: [] };
  let uniqueNoConflictPass = 0;
  let uniqueNoConflictFail = 0;
  let planCPass = 0;
  let candWithTarget = 0;
  let nonsingletonCandidates = 0;

  for (const r of residual) {
    const k = keys.attachKey(r);
    const cands = (k !== null ? (joyByAttach.get(k) ?? []) : []).filter((c) => c.id !== r.id);
    const bucket = cands.length === 0 ? 'none' : cands.length === 1 ? 'unique' : 'ambiguous';
    counts[bucket] += 1;

    if (cands.length >= 1) {
      candWithTarget += 1;
      if (cands.some(isNonSingleton)) nonsingletonCandidates += 1;
    }

    let noConflict = null;
    let planC = null;
    if (bucket === 'unique') {
      const cand = cands[0];
      const candKy = kyNumberOf(cand);
      noConflict = candKy == null || candKy === kyNumberOf(r);
      if (noConflict) uniqueNoConflictPass += 1;
      else uniqueNoConflictFail += 1;
      const rc = keys.componentKeys(r);
      const cc = keys.componentKeys(cand);
      let overlap = 0;
      for (const x of rc) if (cc.has(x)) overlap += 1;
      planC =
        overlap >= 2 || keys.normStrip(r.title_primary) === keys.normStrip(cand.title_primary);
      if (planC) planCPass += 1;
    }

    if (samples[bucket].length < sampleN) {
      samples[bucket].push({
        ky_id: r.id,
        ky_title: r.title_primary,
        ky_artist: r.artist_primary,
        ky_number: kyNumberOf(r),
        attach_key: k,
        cand_count: cands.length,
        cand_nonsingleton: cands.length >= 1 ? cands.some(isNonSingleton) : null,
        no_conflict: noConflict,
        planC_pass: planC,
        candidates: cands.slice(0, 3).map((c) => ({
          id: c.id,
          title: c.title_primary,
          artist: c.artist_primary,
          joysound: joyNumberOf(c),
          ky: kyNumberOf(c),
        })),
      });
    }
  }

  return {
    inputs: { corpusIn: corpus.length, kyIn: ky.length },
    merged: { total: merged.length, residualJoylessKy: residual.length },
    hypothesis_nonsingleton: {
      candidatesWithTarget: candWithTarget,
      nonsingletonCandidates,
      ratio:
        candWithTarget === 0 ? null : Number((nonsingletonCandidates / candWithTarget).toFixed(4)),
    },
    candidateBuckets: { ...counts },
    planA: {
      attachTargets: counts.unique,
      uniqueNoConflictPass,
      uniqueNoConflictFail,
      expectedMerges: uniqueNoConflictPass,
    },
    planC: { uniquePassGuard: planCPass, uniqueFailGuard: counts.unique - planCPass },
    samples,
  };
}

export async function loadDeps() {
  for (const p of [MERGE_JS, CLUSTERING_JS, NORMALIZE_JS]) {
    if (!existsSync(p)) {
      throw new Error(`missing ${p} — run \`corepack pnpm -r build\` first.`);
    }
  }
  const { mergeRecords, stripContextSuffix } = await import(pathToFileURL(MERGE_JS).href);
  const { getLeadComponent, splitArtistCollab, normalizeForMatch } = await import(
    pathToFileURL(CLUSTERING_JS).href
  );
  const { normalize } = await import(pathToFileURL(NORMALIZE_JS).href);
  return {
    mergeRecords,
    deps: { normalize, getLeadComponent, splitArtistCollab, normalizeForMatch, stripContextSuffix },
  };
}

async function main() {
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
  for (const [flag, val] of [
    ['--corpus', args.corpus],
    ['--ky', args.ky],
    ['--out', args.out],
  ]) {
    if (!val) {
      console.error(`ERROR: ${flag} is required`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
  }
  const corpusPath = resolve(args.corpus);
  const kyPath = resolve(args.ky);
  for (const p of [corpusPath, kyPath]) {
    if (!existsSync(p)) {
      console.error(`ERROR: input not found: ${p}`);
      process.exitCode = 2;
      return;
    }
  }

  const { mergeRecords, deps } = await loadDeps();
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const ky = JSON.parse(readFileSync(kyPath, 'utf8'));
  const { records: merged } = mergeRecords([...corpus, ...ky]);
  const report = buildReport(corpus, ky, merged, deps, args.samples);

  writeJsonAtomic(resolve(args.out), report, { indent: 2, trailingNewline: true });

  const r = report;
  console.log(`[diagnose-ky] residual joyless ky: ${r.merged.residualJoylessKy}`);
  console.log(
    `[diagnose-ky] non-singleton candidate ratio: ${r.hypothesis_nonsingleton.nonsingletonCandidates}/${r.hypothesis_nonsingleton.candidatesWithTarget} = ${r.hypothesis_nonsingleton.ratio}`,
  );
  console.log(
    `[diagnose-ky] candidate buckets: none ${r.candidateBuckets.none}, unique ${r.candidateBuckets.unique}, ambiguous ${r.candidateBuckets.ambiguous}`,
  );
  console.log(
    `[diagnose-ky] Plan A expected merges (unique + no-conflict): ${r.planA.expectedMerges}; Plan C stronger-guard pass: ${r.planC.uniquePassGuard}`,
  );
  console.log(`[diagnose-ky] wrote ${args.out}`);
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
