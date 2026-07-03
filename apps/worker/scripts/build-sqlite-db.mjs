#!/usr/bin/env node
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKER_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_INPUT_PATH = join(WORKER_ROOT, '..', 'web', 'public', 'data', 'songs.json');
export const DEFAULT_OUTPUT_PATH = join(WORKER_ROOT, '.build', 'sqlite', 'songs.sqlite');

export function parseBuildSqliteArgs(argv) {
  const parsed = {
    inputPath: DEFAULT_INPUT_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    searchHintPaths: [],
    vacuum: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--no-vacuum') {
      parsed.vacuum = false;
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
  // Default ON: this is the serving artifact, so it should always ship
  // compacted. An object caller (tests) that omits the flag opts in too.
  const vacuum = args.vacuum !== false;
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
  if (vacuum) {
    await vacuumDatabaseFile(openSongDatabase, args.outputPath);
  }
  return {
    ...args,
    vacuumed: vacuum,
    songCount,
    bytes: (await stat(args.outputPath)).size,
  };
}

/**
 * Reclaim the free pages the import leaves behind. T5-B/C's row/index deletions
 * (high-df gram1 pruning, dropped song-token index) empty pages that survive in
 * the file until a VACUUM releases them to the OS (raw 154.9MiB vs 127.6MiB
 * VACUUMed on the local 25.8k corpus). VACUUM only relocates pages physically —
 * the logical corpus (every table's rows) is byte-for-byte unchanged.
 *
 * Kept at the build-script level, not in importSongsJson: the library's other
 * consumers (e.g. the delta patcher) mutate a live database in place and must
 * not pay a full-file rewrite on every call. Only the serving-artifact producer
 * wants compaction.
 *
 * `VACUUM INTO` writes the compacted copy to a fresh temp file and never touches
 * the source, so the atomic rename below is the only thing that swaps it in: the
 * output path holds a complete database throughout (the raw import first, the
 * compacted copy after) and never a half-vacuumed file, preserving
 * importSongsJson's atomic-replace guarantee even if the process dies mid-VACUUM.
 */
async function vacuumDatabaseFile(openSongDatabase, dbPath) {
  const tempPath = `${dbPath}.${process.pid}.${Date.now()}.vacuum.tmp`;
  await rm(tempPath, { force: true });
  // Mirror importSongRecordsToDatabaseFile's cleanup: the temp file only becomes
  // dbPath via the rename below, so any earlier failure must leave no orphan.
  let renamed = false;
  try {
    const db = openSongDatabase(dbPath);
    try {
      db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    await rename(tempPath, dbPath);
    renamed = true;
  } finally {
    if (!renamed) {
      await rm(tempPath, { force: true });
    }
  }
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
  console.log(`VACUUM: ${result.vacuumed ? 'on' : 'skipped (--no-vacuum)'}`);
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
    '                                   [--search-hints hints.jsonl ...] [--no-vacuum]',
    '',
    'Options:',
    '  --search-hints <path>       SEARCH-ONLY hint sidecar (generic JSON/JSONL or',
    '                              JOYSOUND detail decision-log rows). Repeatable.',
    '  --no-vacuum                 Skip the final VACUUM. The build otherwise ships',
    '                              a compacted serving artifact (VACUUM reclaims the',
    '                              free pages the import leaves behind); this flag is',
    '                              for faster local dev rebuilds only.',
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
