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
// TJ FILTER ATTRIBUTION (added 2026-07-12, report-only): the crawler's
// --decisions-out and the two drop-artist-leaks --decisions-out passes emit
// per-row admit/drop decision logs under FILTER_DECISIONS_DIR. When that DIR is
// passed as the FOURTH argument, this composer renders a "### TJ filter
// attribution" section: a kept/dropped totals line from tj-filter.jsonl plus an
// aggregate reason→count table (tj-filter admits by via, tj-filter drops by
// reason incl. no-admit-path, and the two drop-artist-leaks files' drops by
// reason, labelled per step). SAME fail-soft contract as the simplified-Chinese
// section: any missing/unreadable file or malformed JSONL line renders a visible
// [!NOTE] instead of throwing — this section must NEVER red the crawl. Omitting
// the arg preserves the body byte-for-byte.
//
// KY FILTER ATTRIBUTION (added 2026-07-16, report-only): the R5 KY adapter's
// --ky-decisions-out writes ky-filter.jsonl into the SAME FILTER_DECISIONS_DIR.
// When that DIR is passed (the same fourth argument as the TJ section), a
// parallel "### KY filter attribution" section is rendered from ky-filter.jsonl
// (kept/dropped totals + admit/drop reason→count table). Same fail-soft
// contract as the TJ section — no new CLI argument.
//
// Usage: node scripts/compose-crawl-pr-body.mjs [conflictsPath] [parityDeltaPath] [chineseSuspectsPath] [filterDecisionsDir]
//   conflictsPath        defaults to /tmp/merge-conflicts.json (the crawl.yml path).
//   parityDeltaPath      optional; when given, its contents are appended.
//   chineseSuspectsPath  optional; when given, the audit section is appended.
//   filterDecisionsDir   optional; when given, the TJ filter attribution section
//                        is appended (reads tj-filter.jsonl + drop-*-leaks.jsonl).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliInvocation } from './lib/cli.mjs';

export const DEFAULT_CONFLICTS_PATH = '/tmp/merge-conflicts.json';

const CHINESE_AUDIT_HEADING = '### Simplified-Chinese audit';
// Cap the rendered rows so a pathological leak burst can't produce a wall of
// table in the PR body; the full set is always in the audit's JSONL artifact.
const CHINESE_AUDIT_MAX_ROWS = 20;

const TJ_FILTER_HEADING = '### TJ filter attribution';
const KY_FILTER_HEADING = '### KY filter attribution';
// The crawler decision log; the two drop-artist-leaks decision logs are keyed
// by their pipeline step name (see scripts/run-post-crawl-pipeline.mjs).
const TJ_FILTER_DECISIONS_FILE = 'tj-filter.jsonl';
// The KY adapter's decision log, written alongside tj-filter.jsonl into the
// same FILTER_DECISIONS_DIR via the crawler's --ky-decisions-out.
const KY_FILTER_DECISIONS_FILE = 'ky-filter.jsonl';
const DROP_LEAKS_FILES = [
  { step: 'drop-kpop-leaks', file: 'drop-kpop-leaks.jsonl' },
  { step: 'drop-cpop-leaks', file: 'drop-cpop-leaks.jsonl' },
];
// Defensive cap on distinct reason rows; the real reason set is ~10.
const TJ_FILTER_MAX_ROWS = 30;

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

/** Report-only section header + a GitHub `[!NOTE]` callout (never throws). */
function tjFilterNote(message) {
  return `\n${TJ_FILTER_HEADING}\n\n> [!NOTE]\n> ${message}\n`;
}

/**
 * Parse a decision JSONL file into an array of plain-object rows. Throws on a
 * read error or a malformed line (the caller catches and renders a note); a
 * line that parses but is not a plain object is dropped (belt-and-suspenders,
 * mirroring the Chinese-audit parser).
 */
function readDecisionRows(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
    .filter((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
}

/** Tally rows by `reason`, sorted by count desc then reason asc (stable). */
function countByReason(rows) {
  const counts = new Map();
  for (const row of rows) {
    const reason = typeof row.reason === 'string' ? row.reason : '(unknown)';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Render the report-only TJ filter attribution section from the decision-log
 * DIR. Fail-soft on every read/parse error (visible note, never throws) — the
 * tj-filter.jsonl anchor missing/malformed yields a whole-section note; a
 * missing/malformed drop-artist-leaks file yields a trailing per-file note but
 * still renders the crawler table.
 */
function composeTjFilterAttributionSection(decisionsDir) {
  if (decisionsDir === undefined) return '';

  const tjPath = join(decisionsDir, TJ_FILTER_DECISIONS_FILE);
  let tjRows;
  try {
    if (!existsSync(tjPath)) {
      return tjFilterNote(
        `Could not read the TJ filter decision log (\`${tjPath}\` not found) — the crawler's --decisions-out step likely failed; see the workflow logs. Report-only: this does not block the crawl.`,
      );
    }
    tjRows = readDecisionRows(tjPath);
  } catch (err) {
    return tjFilterNote(
      `Could not parse the TJ filter decision log (\`${tjPath}\`): ${err.message}. Report-only: this does not block the crawl.`,
    );
  }

  const admits = tjRows.filter((r) => r.decision === 'admit');
  const drops = tjRows.filter((r) => r.decision === 'drop');

  // Build the aggregate table entries: tj-filter admits (by via), tj-filter
  // drops (by reason incl. no-admit-path), then each drop-artist-leaks pass.
  const entries = [];
  for (const [reason, count] of countByReason(admits)) {
    entries.push(['tj-filter', 'admit', reason, count]);
  }
  for (const [reason, count] of countByReason(drops)) {
    entries.push(['tj-filter', 'drop', reason, count]);
  }
  const fileNotes = [];
  for (const { step, file } of DROP_LEAKS_FILES) {
    const path = join(decisionsDir, file);
    try {
      if (!existsSync(path)) {
        fileNotes.push(`\`${file}\` not found — the ${step} pass may not have run.`);
        continue;
      }
      for (const [reason, count] of countByReason(readDecisionRows(path))) {
        entries.push([step, 'drop', reason, count]);
      }
    } catch (err) {
      fileNotes.push(`\`${file}\` could not be parsed: ${err.message}.`);
    }
  }

  let section = `\n${TJ_FILTER_HEADING}\n\n`;
  section += `Kept ${admits.length} / dropped ${drops.length} (from \`${TJ_FILTER_DECISIONS_FILE}\`).\n`;
  if (entries.length === 0) {
    section += '\nNo filter decisions recorded.\n';
  } else {
    const shown = entries.slice(0, TJ_FILTER_MAX_ROWS);
    if (entries.length > shown.length) {
      section += `\n${entries.length} reason rows (showing first ${shown.length}):\n`;
    }
    section += '\n| step | decision | reason | count |\n|---|---|---|---|\n';
    for (const [step, decision, reason, count] of shown) {
      section += `| ${escapeCell(step)} | ${escapeCell(decision)} | ${escapeCell(reason)} | ${count} |\n`;
    }
  }
  if (fileNotes.length > 0) {
    section += `\n> [!NOTE]\n${fileNotes.map((n) => `> ${n}`).join('\n')}\n`;
  }
  return section;
}

/** Report-only section header + a GitHub `[!NOTE]` callout (never throws). */
function kyFilterNote(message) {
  return `\n${KY_FILTER_HEADING}\n\n> [!NOTE]\n> ${message}\n`;
}

/**
 * Render the report-only KY filter attribution section from the decision-log
 * DIR (reads `ky-filter.jsonl`, written by the ky-kysing adapter's
 * --ky-decisions-out). SAME fail-soft contract as the TJ section: any
 * missing/unreadable file or malformed JSONL line renders a visible [!NOTE]
 * instead of throwing. The KY log has no companion drop-artist-leaks files, so
 * this is a single-file kept/dropped totals line + reason→count table (admits
 * by reason, drops by reason). Omitting the DIR arg renders nothing.
 *
 * Unlike the TJ section's anchor (tj-filter.jsonl, always written by the
 * crawler), ky-filter.jsonl is written ONLY when --ky-decisions-out is passed
 * (a newer opt-in) and the ky-kysing adapter ran — so its ABSENCE is not
 * necessarily an error (a --source run that excludes ky, or a crawl predating
 * the flag). An absent file therefore renders NOTHING (byte-parity for callers
 * that only produce a TJ log); a present-but-malformed file still renders a
 * visible [!NOTE] so a broken log is surfaced, never thrown.
 */
function composeKyFilterAttributionSection(decisionsDir) {
  if (decisionsDir === undefined) return '';

  const kyPath = join(decisionsDir, KY_FILTER_DECISIONS_FILE);
  if (!existsSync(kyPath)) return '';
  let rows;
  try {
    rows = readDecisionRows(kyPath);
  } catch (err) {
    return kyFilterNote(
      `Could not parse the KY filter decision log (\`${kyPath}\`): ${err.message}. Report-only: this does not block the crawl.`,
    );
  }

  const admits = rows.filter((r) => r.decision === 'admit');
  const drops = rows.filter((r) => r.decision === 'drop');
  const entries = [];
  for (const [reason, count] of countByReason(admits)) entries.push(['admit', reason, count]);
  for (const [reason, count] of countByReason(drops)) entries.push(['drop', reason, count]);

  let section = `\n${KY_FILTER_HEADING}\n\n`;
  section += `Kept ${admits.length} / dropped ${drops.length} (from \`${KY_FILTER_DECISIONS_FILE}\`).\n`;
  if (entries.length === 0) {
    section += '\nNo filter decisions recorded.\n';
  } else {
    const shown = entries.slice(0, TJ_FILTER_MAX_ROWS);
    if (entries.length > shown.length) {
      section += `\n${entries.length} reason rows (showing first ${shown.length}):\n`;
    }
    section += '\n| decision | reason | count |\n|---|---|---|\n';
    for (const [decision, reason, count] of shown) {
      section += `| ${escapeCell(decision)} | ${escapeCell(reason)} | ${count} |\n`;
    }
  }
  return section;
}

export function composePrBody(
  conflictsPath = DEFAULT_CONFLICTS_PATH,
  parityDeltaPath = undefined,
  chineseSuspectsPath = undefined,
  filterDecisionsDir = undefined,
) {
  let body = 'Automated crawl output. See workflow run for logs.\n';
  body += composeConflictsSection(conflictsPath);
  body += composeParitySection(parityDeltaPath);
  body += composeChineseAuditSection(chineseSuspectsPath);
  body += composeTjFilterAttributionSection(filterDecisionsDir);
  body += composeKyFilterAttributionSection(filterDecisionsDir);
  return body;
}

if (isCliInvocation(import.meta.url)) {
  try {
    process.stdout.write(
      composePrBody(
        process.argv[2] ?? DEFAULT_CONFLICTS_PATH,
        process.argv[3],
        process.argv[4],
        process.argv[5],
      ),
    );
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
