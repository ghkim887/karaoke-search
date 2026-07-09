#!/usr/bin/env node
// PR-body composer for the weekly crawl — extracted verbatim-in-behavior
// from the former inline bash/node step in `.github/workflows/crawl.yml`
// ("Compose PR body with merge-conflict summary").
//
// Reads the merge-conflict summary JSON the crawler wrote via
// `--conflicts-out` (shape: { total, sample: [{ field, values, winner,
// cluster_key }] }) and writes the PR body to STDOUT. crawl.yml redirects
// stdout to "$RUNNER_TEMP/pr_body.md" exactly where the inline step wrote.
//
// Semantics preserved from the inline step:
//   - Missing conflicts file → body is just the boilerplate line.
//   - total == 0            → boilerplate only.
//   - total > 0             → append the "## Merge conflicts during dedup"
//                             section listing every entry of `sample`.
//   - Malformed JSON → throw, exiting non-zero (the old step failed the same
//     way: the `total=$(node -e ...)` command substitution aborted under
//     `bash -e` when JSON.parse threw).
//
// ONE deliberate tightening (NOT byte-parity): valid JSON with a missing or
// non-integer `total` now throws. In the old inline, `[ "$total" -gt 0 ]` was
// the condition of an `if` — exempt from `set -e` — so its error status was
// silently treated as false and the step exited 0 with a boilerplate-only
// body. For a data pipeline, fail-closed on a malformed summary is the right
// call: surface the broken `--conflicts-out` artifact instead of papering
// over it.
//
// PARITY DELTA (added 2026-07-10): the crawl workflow regenerates the
// search-parity baseline from the freshly crawled corpus and renders the
// per-query delta with scripts/compare-parity-baselines.mjs. When a delta path
// is passed as the second argument, its contents are appended verbatim as a
// trailing section so the reviewer sees the drift in the crawl PR body (the
// drift gate moves to PR review). Omitting the argument preserves the original
// conflicts-only behavior byte-for-byte. Passing a path that does not exist is
// fail-closed (throws) — the workflow always produces it, so a missing file
// means the regenerate/compare step silently failed.
//
// Usage: node scripts/compose-crawl-pr-body.mjs [conflictsPath] [parityDeltaPath]
//   conflictsPath   defaults to /tmp/merge-conflicts.json (the crawl.yml path).
//   parityDeltaPath optional; when given, its contents are appended.

import { existsSync, readFileSync } from 'node:fs';
import { isCliInvocation } from './lib/cli.mjs';

export const DEFAULT_CONFLICTS_PATH = '/tmp/merge-conflicts.json';

function composeConflictsSection(conflictsPath) {
  if (!existsSync(conflictsPath)) return '';

  const summary = JSON.parse(readFileSync(conflictsPath, 'utf8'));
  const total = summary.total;
  if (!Number.isInteger(total)) {
    // Intentional tightening vs the old inline step (see header): there,
    // `[ "$total" -gt 0 ]` erroring inside an `if` condition was exempt from
    // `set -e` and silently fell through to a boilerplate-only body, exit 0.
    // We fail closed instead — a present-but-malformed conflicts summary
    // should fail the job, not be papered over.
    throw new Error(`conflicts summary "total" is not an integer: ${total}`);
  }
  if (total <= 0) return '';

  let section = '\n';
  section += '## Merge conflicts during dedup\n';
  section += `- Total: ${total}\n`;
  section += '- Sample (first 10):\n';
  for (const c of summary.sample) {
    const vs = c.values.map((v) => `${v.source}=${v.value}`).join(', ');
    section += `  - ${c.field}: ${vs} -> winner: ${c.winner} (cluster_key=${c.cluster_key})\n`;
  }
  return section;
}

function composeParitySection(parityDeltaPath) {
  if (parityDeltaPath === undefined) return '';
  if (!existsSync(parityDeltaPath)) {
    // Fail-closed: the crawl workflow always regenerates + compares the parity
    // baseline before composing the body, so a missing delta file means that
    // step silently produced nothing — surface it, don't ship a PR without it.
    throw new Error(`parity delta file not found: ${parityDeltaPath}`);
  }
  // The delta markdown already opens with its own "## ..." heading and ends
  // with a newline; a single leading blank line separates it from whatever
  // preceded it (boilerplate line or the conflicts section).
  return `\n${readFileSync(parityDeltaPath, 'utf8')}`;
}

export function composePrBody(conflictsPath = DEFAULT_CONFLICTS_PATH, parityDeltaPath = undefined) {
  let body = 'Automated crawl output. See workflow run for logs.\n';
  body += composeConflictsSection(conflictsPath);
  body += composeParitySection(parityDeltaPath);
  return body;
}

if (isCliInvocation(import.meta.url)) {
  try {
    process.stdout.write(composePrBody(process.argv[2] ?? DEFAULT_CONFLICTS_PATH, process.argv[3]));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
