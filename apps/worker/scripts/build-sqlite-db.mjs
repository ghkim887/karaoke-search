#!/usr/bin/env node
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_INPUT_PATH = join(WORKER_ROOT, '..', 'web', 'public', 'data', 'songs.json');
export const DEFAULT_OUTPUT_PATH = join(WORKER_ROOT, '.wrangler', 'sqlite', 'songs.sqlite');

export function parseBuildSqliteArgs(argv) {
  const parsed = {
    inputPath: DEFAULT_INPUT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    searchHintPaths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
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
    if (arg === '--search-hints') {
      parsed.searchHintPaths.push(requireValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(usage());
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }
  return parsed;
}

export async function buildSqliteDb(argv) {
  const args = Array.isArray(argv) ? parseBuildSqliteArgs(argv) : argv;
  const searchHintPaths = args.searchHintPaths ?? [];
  await mkdir(dirname(args.outputPath), { recursive: true });
  await rm(args.outputPath, { force: true });
  const { importSongsJson, openSongDatabase } = await import('@karaoke/data-store');

  importSongsJson({
    inputPath: args.inputPath,
    dbPath: args.outputPath,
    searchHintPaths,
  });
  const songCount = countSongs(openSongDatabase, args.outputPath);
  if (songCount === 0) {
    // CI corpus gate hardening: an empty songs.json imports "successfully"
    // but would ship a database that serves nothing. Fail loudly instead.
    await rm(args.outputPath, { force: true });
    throw new Error(`Refusing to build an empty database: 0 songs in ${args.inputPath}`);
  }
  return {
    ...args,
    songCount,
    bytes: (await stat(args.outputPath)).size,
  };
}

function countSongs(openSongDatabase, dbPath) {
  const db = openSongDatabase(dbPath);
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM songs').get().count);
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await buildSqliteDb(argv);
  console.log(`Wrote SQLite DB: ${result.outputPath}`);
  console.log(`Input corpus: ${result.inputPath}`);
  console.log(`Songs imported: ${result.songCount}`);
  console.log(`SQLite bytes: ${result.bytes}`);
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
    '  node scripts/build-sqlite-db.mjs [--input songs.json] [--output songs.sqlite]',
    '                                   [--search-hints hints.jsonl ...]',
    '',
    'Options:',
    '  --search-hints <path>       SEARCH-ONLY hint sidecar (generic JSON/JSONL or',
    '                              JOYSOUND detail decision-log rows). Repeatable.',
    '',
    'Defaults:',
    `  --input ${DEFAULT_INPUT_PATH}`,
    `  --output ${DEFAULT_OUTPUT_PATH}`,
  ].join('\n');
}

const entrypointPath = process.argv[1];
if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
