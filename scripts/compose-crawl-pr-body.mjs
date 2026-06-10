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
// Usage: node scripts/compose-crawl-pr-body.mjs [conflictsPath]
//   conflictsPath defaults to /tmp/merge-conflicts.json (the crawl.yml path).

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CONFLICTS_PATH = '/tmp/merge-conflicts.json';

export function composePrBody(conflictsPath = DEFAULT_CONFLICTS_PATH) {
  let body = 'Automated crawl output. See workflow run for logs.\n';
  if (!existsSync(conflictsPath)) return body;

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
  if (total <= 0) return body;

  body += '\n';
  body += '## Merge conflicts during dedup\n';
  body += `- Total: ${total}\n`;
  body += '- Sample (first 10):\n';
  for (const c of summary.sample) {
    const vs = c.values.map((v) => `${v.source}=${v.value}`).join(', ');
    body += `  - ${c.field}: ${vs} -> winner: ${c.winner} (cluster_key=${c.cluster_key})\n`;
  }
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(composePrBody(process.argv[2] ?? DEFAULT_CONFLICTS_PATH));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
