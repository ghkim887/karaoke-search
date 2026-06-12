#!/usr/bin/env node
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_SQL_PATH = join(WORKER_ROOT, '.wrangler', 'import', 'songs-d1.sql');
export const DEFAULT_MAX_STATEMENT_BYTES = 100_000;

export function summarizeD1SqlText(sqlText) {
  const statements = splitSqlStatements(sqlText);
  return {
    totalBytes: Buffer.byteLength(sqlText, 'utf8'),
    statementCount: statements.length,
    maxStatementBytes: statements.reduce(
      (maxBytes, statement) => Math.max(maxBytes, Buffer.byteLength(statement, 'utf8')),
      0,
    ),
  };
}

/**
 * Streams a D1 SQL file to compute the same metrics as `summarizeD1SqlText`
 * without buffering the whole (~1 GB at full-catalog scale) file as a single
 * string. Reads line-by-line via `readline`, restoring the stripped `\n` so the
 * statement-boundary state machine sees identical bytes to the legacy
 * `readFileSync` path. `totalBytes` is the exact on-disk file size (UTF-8, no
 * BOM), matching the legacy `Buffer.byteLength(readFileSync(...))`.
 */
export async function summarizeD1SqlFile(sqlPath) {
  const input = createReadStream(sqlPath, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  const state = { current: '', inString: false };
  let statementCount = 0;
  let maxStatementBytes = 0;
  let firstLine = true;

  const recordStatement = (statement) => {
    statementCount += 1;
    maxStatementBytes = Math.max(maxStatementBytes, Buffer.byteLength(statement, 'utf8'));
  };

  try {
    for await (const line of reader) {
      const fragment = firstLine ? line : `\n${line}`;
      firstLine = false;
      feedSqlFragment(fragment, state, recordStatement);
    }
  } finally {
    reader.close();
    input.destroy();
  }

  const trailingStatement = state.current.trim();
  if (trailingStatement.length > 0) {
    recordStatement(trailingStatement);
  }

  return { totalBytes: statSync(sqlPath).size, statementCount, maxStatementBytes };
}

export function assertD1SqlMetricsWithinLimits(
  metrics,
  { maxStatementBytes = DEFAULT_MAX_STATEMENT_BYTES } = {},
) {
  if (metrics.maxStatementBytes > maxStatementBytes) {
    throw new Error(
      `D1 SQL max statement size ${metrics.maxStatementBytes} bytes exceeds ${maxStatementBytes} bytes`,
    );
  }
}

export function parseMetricsArgs(argv) {
  const parsed = {
    sqlPath: DEFAULT_SQL_PATH,
    maxStatementBytes: DEFAULT_MAX_STATEMENT_BYTES,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-statement-bytes') {
      parsed.maxStatementBytes = parsePositiveInteger(requireValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}

${usage()}`);
    }
    parsed.sqlPath = arg;
  }

  return parsed;
}

export async function reportD1SqlMetrics(argv = process.argv.slice(2)) {
  const args = parseMetricsArgs(argv);
  const metrics = await summarizeD1SqlFile(args.sqlPath);
  assertD1SqlMetricsWithinLimits(metrics, {
    maxStatementBytes: args.maxStatementBytes,
  });
  return { ...metrics, sqlPath: args.sqlPath };
}

export async function main(argv = process.argv.slice(2)) {
  const metrics = await reportD1SqlMetrics(argv);
  const args = parseMetricsArgs(argv);
  if (args.json) {
    console.log(JSON.stringify(metrics));
    return;
  }
  console.log(`D1 SQL path: ${metrics.sqlPath}`);
  console.log(`Total bytes: ${metrics.totalBytes}`);
  console.log(`Statements: ${metrics.statementCount}`);
  console.log(`Max statement bytes: ${metrics.maxStatementBytes}`);
}

/**
 * Statement-boundary state machine shared by the string and streaming paths.
 * Threads incremental text fragments through the same `'`/`''`/`;` rules and
 * invokes `onStatement` for each completed statement, carrying `{ current,
 * inString }` across fragments.
 */
function feedSqlFragment(fragment, state, onStatement) {
  let { current, inString } = state;
  for (let index = 0; index < fragment.length; index += 1) {
    const character = fragment[index];
    current += character;
    if (character === "'") {
      if (inString && fragment[index + 1] === "'") {
        current += fragment[index + 1];
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && character === ';') {
      const statement = current.trim();
      if (statement.length > 0) {
        onStatement(statement);
      }
      current = '';
    }
  }
  state.current = current;
  state.inString = inString;
  return state;
}

function splitSqlStatements(sqlText) {
  const statements = [];
  const state = feedSqlFragment(sqlText, { current: '', inString: false }, (statement) => {
    statements.push(statement);
  });

  const trailingStatement = state.current.trim();
  if (trailingStatement.length > 0) {
    statements.push(trailingStatement);
  }
  return statements;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${optionName}

${usage()}`);
  }
  return value;
}

function parsePositiveInteger(value, optionName) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return parsed;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/report-d1-sql-metrics.mjs [sql-file] [--max-statement-bytes N] [--json]',
    '',
    'Defaults:',
    `  sql-file: ${DEFAULT_SQL_PATH}`,
    `  --max-statement-bytes ${DEFAULT_MAX_STATEMENT_BYTES}`,
  ].join('\n');
}

const entrypointPath = process.argv[1];
if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
