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
// SIMPLIFIED-CHINESE AUDIT (added 2026-07-12): the crawl workflow also runs
// scripts/audit-simplified-chinese.mjs against the freshly crawled corpus. That
// audit writes a JSONL of suspect rows (one compact object per line:
// { id, title_primary, artist_primary, matched_chars, matched_fields }) and
// NEVER gates on findings. When a suspects-JSONL path is passed as the third
// argument, this composer renders those rows as a trailing "### Simplified-
// Chinese audit" section so a reviewer sees any leak the same run it appears.
// Omitting the argument preserves the conflicts+parity body byte-for-byte.
//
// REPORT-ONLY, IN CONTRAST TO THE PARITY DELTA: the parity section is a GATE — a
// missing/malformed file fails the compose step closed. This section must NEVER
// red the crawl, so every failure mode (missing file, unreadable file, a
// malformed JSONL line) renders a VISIBLE note instead of throwing. The audit
// always writes the JSONL when it can read the corpus (an empty file == 0
// suspects), so a missing file means the audit step itself failed — surfaced in
// the body, not swallowed and not blocking.
//
// Usage: node scripts/compose-crawl-pr-body.mjs [conflictsPath] [parityDeltaPath] [chineseSuspectsPath]
//   conflictsPath        defaults to /tmp/merge-conflicts.json (the crawl.yml path).
//   parityDeltaPath      optional; when given, its contents are appended.
//   chineseSuspectsPath  optional; when given, the audit section is appended.

import { existsSync, readFileSync } from 'node:fs';
import { isCliInvocation } from './lib/cli.mjs';

export const DEFAULT_CONFLICTS_PATH = '/tmp/merge-conflicts.json';

const CHINESE_AUDIT_HEADING = '### Simplified-Chinese audit';
// Cap the rendered rows so a pathological leak burst can't produce a wall of
// table in the PR body; the full set is always in the audit's JSONL artifact.
const CHINESE_AUDIT_MAX_ROWS = 20;

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

/** Escape a value so it cannot break out of a markdown table cell. */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * A report-only section header + a GitHub `[!NOTE]` callout. Used for every
 * failure mode so the crawl PR still opens with a VISIBLE breadcrumb rather than
 * a silently missing section — the compose step must never throw on this input.
 */
function chineseAuditNote(message) {
  return `\n${CHINESE_AUDIT_HEADING}\n\n> [!NOTE]\n> ${message}\n`;
}

/**
 * Render the report-only simplified-Chinese-leak audit section from the audit's
 * suspects JSONL. See the header note for why this fails soft (visible note) on
 * every read/parse error instead of fail-closed like the parity delta.
 */
function composeChineseAuditSection(suspectsPath) {
  if (suspectsPath === undefined) return '';

  let suspects;
  try {
    if (!existsSync(suspectsPath)) {
      return chineseAuditNote(
        `Could not read the audit output (\`${suspectsPath}\` not found) — the simplified-Chinese audit step likely failed; see the workflow logs. Report-only: this does not block the crawl.`,
      );
    }
    suspects = readFileSync(suspectsPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      // Drop any line that parses but is not a plain object (`null`, arrays,
      // scalars). Belt-and-suspenders for the "never throws" guarantee: the
      // real audit only ever writes plain suspect objects, but a wrong-shape
      // line must not reach the row render (below) and throw.
      .filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
  } catch (err) {
    return chineseAuditNote(
      `Could not parse the audit output (\`${suspectsPath}\`): ${err.message}. Report-only: this does not block the crawl.`,
    );
  }

  if (suspects.length === 0) return `\n${CHINESE_AUDIT_HEADING}\n\n0 suspects.\n`;

  const shown = suspects.slice(0, CHINESE_AUDIT_MAX_ROWS);
  const plural = suspects.length === 1 ? 'row' : 'rows';
  const countLine =
    suspects.length > shown.length
      ? `${suspects.length} suspect ${plural} (showing first ${shown.length}):`
      : `${suspects.length} suspect ${plural}:`;
  const table = [
    '| id | title | artist | matched chars |',
    '|---|---|---|---|',
    ...shown.map(
      (s) =>
        // matched_chars is coerced (not `?? []`) so a non-array value — e.g. a
        // string — can never throw on `.join`; see the "never throws" note.
        `| ${escapeCell(s.id)} | ${escapeCell(s.title_primary)} | ${escapeCell(s.artist_primary)} | ${escapeCell(Array.isArray(s.matched_chars) ? s.matched_chars.join(' ') : '')} |`,
    ),
  ];
  return `\n${CHINESE_AUDIT_HEADING}\n\n${countLine}\n\n${table.join('\n')}\n`;
}

export function composePrBody(
  conflictsPath = DEFAULT_CONFLICTS_PATH,
  parityDeltaPath = undefined,
  chineseSuspectsPath = undefined,
) {
  let body = 'Automated crawl output. See workflow run for logs.\n';
  body += composeConflictsSection(conflictsPath);
  body += composeParitySection(parityDeltaPath);
  body += composeChineseAuditSection(chineseSuspectsPath);
  return body;
}

if (isCliInvocation(import.meta.url)) {
  try {
    process.stdout.write(
      composePrBody(process.argv[2] ?? DEFAULT_CONFLICTS_PATH, process.argv[3], process.argv[4]),
    );
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
