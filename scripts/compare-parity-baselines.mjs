#!/usr/bin/env node
// Search-parity baseline comparator — renders the drift between two
// search-parity baselines as a markdown section for the weekly crawl PR body.
// A baseline is the snapshot written by apps/web/src/lib/search-parity.golden.test.ts
// (apps/web/src/lib/__snapshots__/search-parity.baseline.json).
//
// WHY THIS EXISTS (policy, owner-approved 2026-07-10):
// The search-parity golden gate sha256-pins the committed corpus. The weekly
// crawl rewrites the corpus by design, so that gate can only pass once its
// baseline is regenerated from the new corpus. Regenerating the baseline
// silently would rubber-stamp any ranking drift the new corpus introduces —
// the whole point of the gate is a human noticing when the two search paths
// diverge more than before. So the crawl workflow regenerates the baseline AND
// runs this comparator (old committed baseline vs freshly regenerated one) to
// put the per-query delta in the crawl PR body. The human gate that used to be
// "regenerate the baseline by hand and eyeball the diff" moves to the crawl-PR
// review, with THIS delta as the thing being reviewed.
//
// A shrinking Jaccard or a lost top-1 agreement is a genuine search regression
// (the two engines diverged more than before), flagged loudly so a reviewer
// must acknowledge it before merge. This comparator NEVER fails the build on a
// regression: the crawl PR must still open so a human can see the delta and
// decide. It exits non-zero only on bad arguments or an unreadable/malformed
// baseline (fail-closed, same posture as compose-crawl-pr-body.mjs).
//
// Usage: node scripts/compare-parity-baselines.mjs <old-baseline.json> <new-baseline.json>

import { readFileSync } from 'node:fs';
import { isCliInvocation } from './lib/cli.mjs';

export const SECTION_HEADING = '## Search-parity baseline delta';
// U+26A0 WARNING SIGN so the regression flag is visually loud in the PR body.
export const REGRESSION_TAG = '⚠ REGRESSION -- requires human attention before merge';
export const NO_DRIFT_LINE =
  'No per-query drift: every query Jaccard and top-1 agreement is unchanged.';

const INTRO =
  'The weekly crawl rewrites the corpus, so this baseline is regenerated from ' +
  'the freshly crawled corpus (its sha256 changes by design). Review the drift ' +
  'below before merging: a shrinking Jaccard or a lost top-1 agreement means the ' +
  'two search paths diverged more than before, which is a real regression rather ' +
  'than a rubber stamp.';

const USAGE =
  'Usage: node scripts/compare-parity-baselines.mjs <old-baseline.json> <new-baseline.json>';

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function fmtNum(value) {
  return value.toFixed(6);
}

/** "0.621149 -> 0.622000 (+0.000851)" — delta rounded to 6 dp, always signed. */
function fmtFloatDelta(oldValue, newValue) {
  const delta = round6(newValue - oldValue);
  const sign = delta < 0 ? '' : '+';
  return `${fmtNum(oldValue)} -> ${fmtNum(newValue)} (${sign}${delta.toFixed(6)})`;
}

/** "26133 -> 26140 (+7)" for the integer record count. */
function fmtIntDelta(oldValue, newValue) {
  const delta = newValue - oldValue;
  const sign = delta < 0 ? '' : '+';
  return `${oldValue} -> ${newValue} (${sign}${delta})`;
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

/** Escape a value so it cannot break out of a markdown table cell. */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Validate the shape this comparator depends on. Fail-closed: a
 * present-but-malformed baseline should fail the job loudly, not silently
 * render an empty/garbage delta. Only the fields the comparator reads are
 * checked (web/worker id lists are informational and not required here).
 */
export function assertBaselineShape(baseline, label) {
  assert(baseline !== null && typeof baseline === 'object', `${label}: not a JSON object`);
  assert(
    baseline.aggregate !== null && typeof baseline.aggregate === 'object',
    `${label}: missing "aggregate" object`,
  );
  assert(
    typeof baseline.aggregate.meanJaccard === 'number',
    `${label}: aggregate.meanJaccard is not a number`,
  );
  assert(
    typeof baseline.aggregate.top1MatchRate === 'number',
    `${label}: aggregate.top1MatchRate is not a number`,
  );
  assert(
    baseline.corpus !== null && typeof baseline.corpus === 'object',
    `${label}: missing "corpus" object`,
  );
  assert(Number.isInteger(baseline.corpus.records), `${label}: corpus.records is not an integer`);
  assert(
    baseline.queries !== null && typeof baseline.queries === 'object',
    `${label}: missing "queries" object`,
  );
  for (const [id, entry] of Object.entries(baseline.queries)) {
    assert(entry !== null && typeof entry === 'object', `${label}: queries.${id} is not an object`);
    assert(typeof entry.jaccard === 'number', `${label}: queries.${id}.jaccard is not a number`);
    assert(
      typeof entry.top1Match === 'boolean',
      `${label}: queries.${id}.top1Match is not a boolean`,
    );
  }
  return baseline;
}

export function loadBaseline(path, label = path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`${label}: cannot read baseline file: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}: invalid JSON: ${err.message}`);
  }
  return assertBaselineShape(parsed, label);
}

/**
 * Compare two validated baselines. Returns the markdown section plus the
 * decision-relevant counts (so callers/tests can inspect them without parsing
 * the rendered string).
 *
 * A row is emitted ONLY when a query's Jaccard or top-1 agreement changed. A
 * negative Jaccard delta OR a lost top-1 agreement (was `true`, now `false`) is
 * a regression and is tagged loudly. Queries added/removed between baselines are
 * surfaced separately (a weekly crawl never changes the fixture query set).
 */
export function compareBaselines(oldBaseline, newBaseline) {
  const oldQueries = oldBaseline.queries;
  const newQueries = newBaseline.queries;
  const ids = [...new Set([...Object.keys(oldQueries), ...Object.keys(newQueries)])].sort();

  const rows = [];
  const added = [];
  const removed = [];
  let regressionCount = 0;

  for (const id of ids) {
    const before = oldQueries[id];
    const after = newQueries[id];
    if (before !== undefined && after === undefined) {
      removed.push(id);
      rows.push({
        id,
        query: before.query,
        jaccardCell: `${fmtNum(before.jaccard)} -> n/a`,
        top1Cell: `${yesNo(before.top1Match)} -> n/a`,
        status: 'query set changed (removed)',
      });
      continue;
    }
    if (before === undefined && after !== undefined) {
      added.push(id);
      rows.push({
        id,
        query: after.query,
        jaccardCell: `n/a -> ${fmtNum(after.jaccard)}`,
        top1Cell: `n/a -> ${yesNo(after.top1Match)}`,
        status: 'query set changed (added)',
      });
      continue;
    }
    const jaccardDelta = round6(after.jaccard - before.jaccard);
    const top1Changed = before.top1Match !== after.top1Match;
    if (jaccardDelta === 0 && !top1Changed) continue; // unchanged — omit

    const lostTop1 = before.top1Match === true && after.top1Match === false;
    const isRegression = jaccardDelta < 0 || lostTop1;
    if (isRegression) regressionCount += 1;
    rows.push({
      id,
      query: after.query,
      jaccardCell: fmtFloatDelta(before.jaccard, after.jaccard),
      top1Cell: `${yesNo(before.top1Match)} -> ${yesNo(after.top1Match)}`,
      status: isRegression ? REGRESSION_TAG : 'improved',
    });
  }

  const querySetChanged = added.length > 0 || removed.length > 0;
  const hasRegression = regressionCount > 0;

  const blocks = [SECTION_HEADING, INTRO];

  blocks.push(
    [
      `- Mean Jaccard: ${fmtFloatDelta(oldBaseline.aggregate.meanJaccard, newBaseline.aggregate.meanJaccard)}`,
      `- Top-1 match rate: ${fmtFloatDelta(oldBaseline.aggregate.top1MatchRate, newBaseline.aggregate.top1MatchRate)}`,
      `- Corpus records: ${fmtIntDelta(oldBaseline.corpus.records, newBaseline.corpus.records)}`,
    ].join('\n'),
  );

  const warnLines = [];
  if (hasRegression) {
    const noun = regressionCount === 1 ? 'query' : 'queries';
    warnLines.push(
      `${regressionCount} ${noun} regressed (Jaccard dropped or top-1 agreement lost). This is a real search regression, not corpus growth -- requires human attention before merge.`,
    );
  }
  if (querySetChanged) {
    warnLines.push(
      `Query set changed (added: ${added.length > 0 ? added.join(', ') : 'none'}; removed: ${removed.length > 0 ? removed.join(', ') : 'none'}). A weekly crawl does not change the fixture query set -- investigate before merge.`,
    );
  }
  if (warnLines.length > 0) {
    blocks.push(['> [!WARNING]', ...warnLines.map((line) => `> ${line}`)].join('\n'));
  }

  if (rows.length === 0) {
    blocks.push(NO_DRIFT_LINE);
  } else {
    const table = [
      '| Query id | Query | Jaccard (old -> new) | Top-1 (old -> new) | Status |',
      '|---|---|---|---|---|',
      ...rows.map(
        (row) =>
          `| ${row.id} | ${escapeCell(row.query)} | ${row.jaccardCell} | ${row.top1Cell} | ${row.status} |`,
      ),
    ];
    blocks.push(table.join('\n'));
  }

  return {
    markdown: `${blocks.join('\n\n')}\n`,
    hasRegression,
    regressionCount,
    changedCount: rows.length,
    added,
    removed,
    querySetChanged,
  };
}

export function parseArgs(argv) {
  const positionals = [];
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    positionals.push(arg);
  }
  if (help) return { oldPath: null, newPath: null, help: true };
  if (positionals.length !== 2) {
    throw new Error(
      `expected exactly 2 positional arguments (old-baseline new-baseline), got ${positionals.length}`,
    );
  }
  return { oldPath: positionals[0], newPath: positionals[1], help: false };
}

export function runCli(argv, out = process.stdout, err = process.stderr) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err.write(`${e.message}\n${USAGE}\n`);
    return 1;
  }
  if (args.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  let oldBaseline;
  let newBaseline;
  try {
    oldBaseline = loadBaseline(args.oldPath, `old baseline (${args.oldPath})`);
    newBaseline = loadBaseline(args.newPath, `new baseline (${args.newPath})`);
  } catch (e) {
    err.write(`${e.message}\n`);
    return 1;
  }
  out.write(compareBaselines(oldBaseline, newBaseline).markdown);
  return 0;
}

if (isCliInvocation(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
