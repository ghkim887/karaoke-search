#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

export function reportD1SqlMetrics(argv = process.argv.slice(2)) {
  const args = parseMetricsArgs(argv);
  const metrics = summarizeD1SqlText(readFileSync(args.sqlPath, 'utf8'));
  assertD1SqlMetricsWithinLimits(metrics, {
    maxStatementBytes: args.maxStatementBytes,
  });
  return { ...metrics, sqlPath: args.sqlPath };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseMetricsArgs(argv);
  const metrics = summarizeD1SqlText(readFileSync(args.sqlPath, 'utf8'));
  assertD1SqlMetricsWithinLimits(metrics, {
    maxStatementBytes: args.maxStatementBytes,
  });
  if (args.json) {
    console.log(JSON.stringify({ ...metrics, sqlPath: args.sqlPath }));
    return;
  }
  console.log(`D1 SQL path: ${args.sqlPath}`);
  console.log(`Total bytes: ${metrics.totalBytes}`);
  console.log(`Statements: ${metrics.statementCount}`);
  console.log(`Max statement bytes: ${metrics.maxStatementBytes}`);
}

function splitSqlStatements(sqlText) {
  const statements = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < sqlText.length; index += 1) {
    const character = sqlText[index];
    current += character;
    if (character === "'") {
      if (inString && sqlText[index + 1] === "'") {
        current += sqlText[index + 1];
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && character === ';') {
      const statement = current.trim();
      if (statement.length > 0) {
        statements.push(statement);
      }
      current = '';
    }
  }

  const trailingStatement = current.trim();
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
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
