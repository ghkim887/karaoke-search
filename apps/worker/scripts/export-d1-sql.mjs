#!/usr/bin/env node
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_INPUT_PATH = join(WORKER_ROOT, '..', 'web', 'public', 'data', 'songs.json');
export const DEFAULT_OUTPUT_PATH = join(WORKER_ROOT, '.wrangler', 'import', 'songs-d1.sql');

export function parseExportArgs(argv) {
  const parsed = {
    inputPath: DEFAULT_INPUT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    includeSchema: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      parsed.inputPath = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output') {
      parsed.outputPath = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--schema') {
      parsed.includeSchema = true;
      continue;
    }
    if (arg === '--no-schema') {
      parsed.includeSchema = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return parsed;
}

export async function exportD1Sql(argv) {
  const args = Array.isArray(argv) ? parseExportArgs(argv) : argv;
  await mkdir(dirname(args.outputPath), { recursive: true });
  const { exportD1ImportSqlJson } = await import(
    pathToFileURL(join(WORKER_ROOT, '..', '..', 'packages', 'data-store', 'dist', 'index.js')).href
  );
  exportD1ImportSqlJson({
    inputPath: args.inputPath,
    outputPath: args.outputPath,
    includeSchema: args.includeSchema,
  });
  return {
    ...args,
    bytes: (await stat(args.outputPath)).size,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await exportD1Sql(argv);
  console.log(`Wrote D1 import SQL: ${result.outputPath}`);
  console.log(`Input corpus: ${result.inputPath}`);
  console.log(`Schema included: ${result.includeSchema ? 'yes' : 'no'}`);
  console.log(`SQL bytes: ${result.bytes}`);
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${optionName}\n\n${usage()}`);
  }
  return value;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/export-d1-sql.mjs [--input songs.json] [--output songs-d1.sql] [--schema|--no-schema]',
    '',
    'Defaults:',
    `  --input ${DEFAULT_INPUT_PATH}`,
    `  --output ${DEFAULT_OUTPUT_PATH}`,
    '  --no-schema',
  ].join('\n');
}

const entrypointPath = process.argv[1];
if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
