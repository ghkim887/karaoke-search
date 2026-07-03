#!/usr/bin/env node
/**
 * JOYSOUND decision-log OFFLINE CLASSIFIER REPLAY.
 *
 * Re-runs the CURRENT built classifier over an existing detail-sweep decision
 * log (`scripts/joysound-detail-sweep.mjs` output, ~291k rows / ~192 MB) with
 * NO network traffic: every row already carries its compacted `detail`, so the
 * replay rebuilds the sweep's exact classifier inputs and writes a NEW decision
 * log in the same row schema and order. Purpose: prove a classifier change
 * (e.g. the 2026-06-12 洋楽 veto on the `admit-jp-detail` recovery) flips ONLY
 * the rows it is supposed to flip, without re-running the multi-day sweep.
 *
 * Input reconstruction mirrors the sweep exactly:
 *  - the `JoysoundListItem` is rebuilt from the row's identity fields
 *    (`selSongNoRaw` preferred over `selSongNo`, `title`/`artist`/`tieupInfo`);
 *    `artistId`/`tieupId` were never persisted and the classifier never reads
 *    them, so they replay as `null`.
 *  - the compacted `detail` is RE-HYDRATED: the sweep's `compactDetail`
 *    omitted null/undefined/empty-array fields, but the classifier spreads
 *    `detail.genreNames` / `detail.tieupNames` (throws on undefined), so the
 *    missing fields are restored to the `JoysoundDetail` defaults (nulls /
 *    empty arrays — see `rehydrateDetail`). The optional foreign-name fields
 *    stay ABSENT when omitted, matching `parseJoysoundDetail`'s
 *    only-assign-when-present contract. Rows without `detail` (fetch failures)
 *    replay listing-only, exactly like the sweep's fallback.
 *  - the known-Japanese-artist predicate is rebuilt by the SAME exported
 *    builder the sweep used (`buildKnownJapaneseArtistPredicate`) from the same
 *    corpus, and the curated overrides are the classifier defaults — the same
 *    way the sweep passed them (it didn't override them).
 *
 * Output rows preserve every original field verbatim — including the original
 * compacted `detail`, which is carried through UNCHANGED (never re-compacted)
 * — except `decision` and `reason`, which take the replayed verdict.
 * `detailFlipRisk` is also refreshed because it is a pure function of `reason`
 * (a flipped row keeping its stale flip-risk flag would be internally
 * inconsistent; unflipped rows get a byte-identical value).
 *
 * Ends with a DELTA SUMMARY (rows, flips by direction, old→new reason
 * breakdown) and a PURITY CHECK: every admit→drop flip must carry the `洋楽`
 * genre tag or be one of the curated DROP overrides, and every drop→admit flip
 * must be a curated ALLOW override admitting via `reviewed-allow`. Any
 * violation prints (first 10) and exits 1. The full flip list is written to
 * `--flips-out`. Both outputs are written `.tmp`-then-rename so a
 * crash never leaves a partial file at the final path.
 *
 * Usage:
 *   node scripts/joysound-replay-classifier.mjs [--in <decision-log.jsonl>]
 *     [--out <replayed.jsonl>] [--flips-out <flips.jsonl>] [--corpus <songs.json>]
 */
import { createWriteStream, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliInvocation } from './lib/cli.mjs';
import { loadJoysoundClassifier } from './lib/joysound-dist.mjs';
import { buildKnownJapaneseArtistPredicate } from './lib/joysound-jp-artist.mjs';
import { streamJsonl } from './lib/jsonl.mjs';
import { endStream, writeLineBackpressured } from './lib/stream.mjs';

const SWEEP_DIR = '../.tmp_review/joysound-detail-sweep-20260610/';
const DEFAULT_IN = fileURLToPath(new URL(`${SWEEP_DIR}decision-log.jsonl`, import.meta.url));
const DEFAULT_OUT = fileURLToPath(
  new URL(`${SWEEP_DIR}decision-log.replayed.jsonl`, import.meta.url),
);
const DEFAULT_FLIPS_OUT = fileURLToPath(
  new URL(`${SWEEP_DIR}decision-log.replay-flips.jsonl`, import.meta.url),
);
const DEFAULT_CORPUS = fileURLToPath(
  new URL('../apps/web/public/data/songs.json', import.meta.url),
);

/** JOYSOUND's Western-music genre tag — the classifier's step-6 veto signal. */
const YOUGAKU_GENRE = '洋楽';

/**
 * The 2 Layer-3 precision-audit DROP overrides (2026-06-12) — the only
 * admit→drop flips allowed WITHOUT a 洋楽 genre tag (their details carry no
 * `genreNames` at all). Keep in lock-step with
 * `packages/crawler/src/adapters/joysound-official/reviewedJoysoundOverrides.ts`.
 */
const CURATED_DROP_SELSONGNOS = new Set(['154010', '488568']);

/**
 * The 1 owner-approved curated ALLOW recovery (2026-06-12) — the only
 * drop→admit flip allowed, and ONLY with the new reason `reviewed-allow`:
 * `623552` (LEveL / SawanoHiroyuki[nZk]:TOMORROW X TOGETHER, Solo Leveling
 * anime OP — the TXT component tripped `foreign-korean`; sole recall loss
 * among the 17,318 known blog-sourced numbers). Keep in lock-step with
 * `packages/crawler/src/adapters/joysound-official/reviewedJoysoundOverrides.ts`.
 */
const CURATED_ALLOW_SELSONGNOS = new Set(['623552']);

const PROGRESS_EVERY = 25_000;

/**
 * Rebuild the `JoysoundListItem` the sweep classified, from a decision-log
 * row's identity fields. Mirrors the sweep's `normalizeListItem` conventions
 * (string coercion, `?? null` for tieupInfo) — `artistId`/`tieupId` were never
 * persisted in the log and the classifier never reads them, so `null`.
 *
 * @param {Record<string, unknown>} row - one parsed decision-log row
 */
export function rebuildListItem(row) {
  return {
    naviGroupId: String(row.naviGroupId ?? ''),
    selSongNo: String(row.selSongNoRaw ?? row.selSongNo ?? ''),
    songName: String(row.title ?? ''),
    artistName: String(row.artist ?? ''),
    artistId: null,
    tieupInfo: row.tieupInfo ?? null,
    tieupId: null,
  };
}

/**
 * Re-hydrate a compacted `detail` back into a full `JoysoundDetail`. The
 * sweep's `compactDetail` omitted keys whose value was null / undefined /
 * empty-array (and dropped `lyricIntro`), so this restores every missing field
 * to the `parseJoysoundDetail` default: `null` for optional strings, `[]` for
 * list fields. The four optional foreign-name fields (`songNameForeign`,
 * `songNameForeignSearch`, `artistNameForeign`, `artistNameForeignSearch`) are
 * deliberately NOT defaulted — they must stay ABSENT when omitted, matching
 * the only-assign-when-present `JoysoundDetail` contract the classifier's
 * `foreignNameSignal` reads with `?? ''`.
 *
 * @param {Record<string, unknown>} compact - the row's persisted `detail`
 */
export function rehydrateDetail(compact) {
  return {
    songId: null,
    songNameRuby: null,
    artistName: null,
    artistId: null,
    lyricist: null,
    composer: null,
    relDate: null,
    newFlg: null,
    lyricIntro: null,
    genreNames: [],
    tieupNames: [],
    aplServicePublishDates: [],
    ...compact,
  };
}

/**
 * Compare an original row against its replayed counterpart. Returns `null`
 * when the decision is unchanged, else a flip record carrying everything the
 * purity check and the flips JSONL need.
 *
 * @param {Record<string, unknown>} oldRow - original decision-log row
 * @param {{ decision: string, reason: string }} newRow - replayed row
 */
export function classifyFlip(oldRow, newRow) {
  if (oldRow.decision === newRow.decision) return null;
  const genreNames = Array.isArray(oldRow.detail?.genreNames) ? oldRow.detail.genreNames : [];
  return {
    kind: oldRow.decision === 'admit' ? 'admit->drop' : 'drop->admit',
    selSongNo: String(oldRow.selSongNo ?? ''),
    naviGroupId: String(oldRow.naviGroupId ?? ''),
    title: String(oldRow.title ?? ''),
    artist: String(oldRow.artist ?? ''),
    oldDecision: oldRow.decision,
    newDecision: newRow.decision,
    oldReason: oldRow.reason,
    newReason: newRow.reason,
    genreNames,
  };
}

/**
 * Purity check for one flip. Policy (Layer-3 precision audit, 2026-06-12):
 *  - drop→admit flips are FORBIDDEN — no row may gain admission — EXCEPT the
 *    curated ALLOW overrides, and only when the new reason is `reviewed-allow`
 *    (the exact-number override gate; any other reason means an organic gate
 *    started admitting the row and must FAIL the purity check).
 *  - admit→drop flips are allowed ONLY when the row carries the `洋楽` genre
 *    tag AND its old reason was `admit-jp-detail` (the veto is SCOPED to the
 *    step-6 recovery — a 洋楽 row losing an `admit-anime` / `admit-jpop-kana`
 *    / `admit-jp-artist` verdict means the veto leaked into another gate and
 *    must FAIL the gate), or when the row is one of the 2 curated DROP
 *    overrides.
 * Returns a violation message, or `null` when the flip is expected.
 *
 * @param {ReturnType<typeof classifyFlip> & object} flip
 */
export function flipPurityViolation(flip) {
  const ident = `selSongNo=${flip.selSongNo} (${flip.artist} — ${flip.title}) ${flip.oldReason} → ${flip.newReason}`;
  if (flip.kind === 'drop->admit') {
    if (CURATED_ALLOW_SELSONGNOS.has(flip.selSongNo) && flip.newReason === 'reviewed-allow') {
      return null;
    }
    return `forbidden drop→admit flip (not a curated ALLOW admitting via reviewed-allow): ${ident}`;
  }
  if (flip.oldReason === 'admit-jp-detail' && flip.genreNames.includes(YOUGAKU_GENRE)) return null;
  if (CURATED_DROP_SELSONGNOS.has(flip.selSongNo)) return null;
  return `admit→drop flip is not a ${YOUGAKU_GENRE}-vetoed admit-jp-detail row and not a curated DROP: ${ident}`;
}

/**
 * Core replay, exported for tests. Streams `inPath` line-by-line (never
 * whole-file — the real log is ~192 MB), replays each row through the current
 * built classifier, and writes the replayed log + flip list `.tmp`-then-rename.
 * Returns the stats object (incl. `violations`); the CLI maps violations to
 * exit 1.
 *
 * @param {{ inPath: string, outPath: string, flipsOutPath: string, corpusPath: string }} opts
 */
export async function runReplay({ inPath, outPath, flipsOutPath, corpusPath }) {
  const { buildJoysoundDecision } = await loadJoysoundClassifier('joysound-replay');

  // Pass the detail-sweep label so the predicate-build log line stays the exact
  // string this replay historically emitted (it reused the sweep's builder).
  const isKnownJapaneseArtist = await buildKnownJapaneseArtistPredicate(corpusPath, {
    label: 'joysound-detail-sweep',
  });

  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(flipsOutPath), { recursive: true });
  const outTmp = `${outPath}.tmp`;
  const flipsTmp = `${flipsOutPath}.tmp`;
  const out = createWriteStream(outTmp, { encoding: 'utf8' });
  const flipsOut = createWriteStream(flipsTmp, { encoding: 'utf8' });

  const stats = {
    rows: 0,
    changed: 0,
    admitToDrop: 0,
    dropToAdmit: 0,
    /** @type {Map<string, number>} old→new reason pair counts for changed rows. */
    reasonPairs: new Map(),
    /** @type {string[]} first 10 purity violations (all are counted). */
    violations: [],
    violationCount: 0,
  };

  try {
    const onParseError = (err, lineNo) => {
      // The sweep guarantees a newline-terminated, parseable log; a corrupt
      // line means the input is not the artifact this replay expects, and a
      // silently skipped row would invalidate the purity proof. Fail fast.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[joysound-replay] unparseable decision-log line ${lineNo}: ${msg}`);
    };
    for await (const row of streamJsonl(inPath, { onParseError })) {
      stats.rows += 1;

      const listItem = rebuildListItem(row);
      const detail = row.detail ? rehydrateDetail(row.detail) : undefined;
      const decision = buildJoysoundDecision(listItem, {
        ...(detail ? { detail } : {}),
        ...(isKnownJapaneseArtist ? { isKnownJapaneseArtist } : {}),
      });

      // Original fields verbatim (incl. the original compacted `detail`,
      // carried through unchanged); only the replayed verdict fields move.
      // `detailFlipRisk` is derived purely from `reason`, so it follows.
      const newRow = {
        ...row,
        decision: decision.decision,
        reason: decision.reason,
        detailFlipRisk: decision.detailFlipRisk,
      };
      await writeLineBackpressured(out, `${JSON.stringify(newRow)}\n`);

      const flip = classifyFlip(row, newRow);
      if (flip) {
        stats.changed += 1;
        if (flip.kind === 'admit->drop') stats.admitToDrop += 1;
        else stats.dropToAdmit += 1;
        const pairKey = `${flip.oldReason} → ${flip.newReason}`;
        stats.reasonPairs.set(pairKey, (stats.reasonPairs.get(pairKey) ?? 0) + 1);
        await writeLineBackpressured(flipsOut, `${JSON.stringify(flip)}\n`);
        const violation = flipPurityViolation(flip);
        if (violation !== null) {
          stats.violationCount += 1;
          if (stats.violations.length < 10) stats.violations.push(violation);
        }
      }

      if (stats.rows % PROGRESS_EVERY === 0) {
        console.log(
          `[joysound-replay] heartbeat: ${stats.rows} rows replayed ` +
            `(${stats.changed} changed, ${stats.violationCount} violation(s))`,
        );
      }
    }
  } finally {
    await Promise.all([endStream(out), endStream(flipsOut)]);
  }
  renameSync(outTmp, outPath);
  renameSync(flipsTmp, flipsOutPath);

  printDeltaSummary(stats, { outPath, flipsOutPath });
  return stats;
}

/**
 * @param {{ rows: number, changed: number, admitToDrop: number, dropToAdmit: number,
 *   reasonPairs: Map<string, number>, violations: string[], violationCount: number }} stats
 * @param {{ outPath: string, flipsOutPath: string }} paths
 */
function printDeltaSummary(stats, { outPath, flipsOutPath }) {
  console.log('[joysound-replay] DELTA SUMMARY');
  console.log(`  rows total:        ${stats.rows}`);
  console.log(
    `  decisions changed: ${stats.changed} (admit→drop ${stats.admitToDrop}, drop→admit ${stats.dropToAdmit})`,
  );
  if (stats.reasonPairs.size > 0) {
    console.log('  changed-row breakdown (old reason → new reason):');
    for (const [pair, n] of [...stats.reasonPairs.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pair}: ${n}`);
    }
  }
  console.log(`  replayed log:      ${outPath}`);
  console.log(`  flip list:         ${flipsOutPath}`);
  if (stats.violationCount === 0) {
    console.log(
      `  PURITY CHECK: OK — every admit→drop flip is a ${YOUGAKU_GENRE}-vetoed admit-jp-detail row or a curated DROP; every drop→admit flip is a curated ALLOW admitting via reviewed-allow`,
    );
  } else {
    console.error(
      `  PURITY CHECK: FAILED — ${stats.violationCount} violation(s); first ${stats.violations.length}:`,
    );
    for (const v of stats.violations) console.error(`    ${v}`);
  }
}

function usage() {
  console.log(
    `usage: node scripts/joysound-replay-classifier.mjs [options]

Re-runs the current built classifier over a JOYSOUND detail-sweep decision log
(offline — no network) and writes a replayed log + flip list, with a purity
check on the flips. Exits 1 on any purity violation. Note: purity violations
can also indicate corpus drift — a --corpus differing from the one the sweep
ran with changes the known-JP-artist predicate (admit-jp-artist verdicts).

options:
  --in <path>         input decision log (default: ${DEFAULT_IN})
  --out <path>        replayed decision log (default: ${DEFAULT_OUT})
  --flips-out <path>  full flip list JSONL (default: ${DEFAULT_FLIPS_OUT})
  --corpus <path>     corpus for the known-JP-artist set (default: ${DEFAULT_CORPUS})
  --help              print this usage and exit`,
  );
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = {
    inPath: DEFAULT_IN,
    outPath: DEFAULT_OUT,
    flipsOutPath: DEFAULT_FLIPS_OUT,
    corpusPath: DEFAULT_CORPUS,
    help: false,
  };
  const keyMap = new Map([
    ['--in', 'inPath'],
    ['--out', 'outPath'],
    ['--flips-out', 'flipsOutPath'],
    ['--corpus', 'corpusPath'],
  ]);
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const prop = keyMap.get(flag);
    if (prop === undefined) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') {
      throw new Error(`missing value for ${flag}`);
    }
    opts[prop] = value;
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(`[joysound-replay] ${err instanceof Error ? err.message : String(err)}`);
    usage();
    process.exit(2);
  }
  if (opts.help) {
    usage();
    return;
  }
  const stats = await runReplay(opts);
  if (stats.violationCount > 0) process.exit(1);
}

if (isCliInvocation(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
