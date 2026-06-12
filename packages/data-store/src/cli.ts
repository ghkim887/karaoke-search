#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { exportD1ImportSqlJson, exportSongsJson, importSongsJson } from './index.js';

export async function runDataStoreCli(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;

  if (command === 'import-json') {
    importSongsJson({
      inputPath: requireOption(args, '--input'),
      dbPath: requireOption(args, '--db'),
    });
    return;
  }

  if (command === 'export-json') {
    exportSongsJson({
      dbPath: requireOption(args, '--db'),
      outputPath: requireOption(args, '--output'),
    });
    return;
  }

  if (command === 'export-d1-sql') {
    await exportD1ImportSqlJson({
      inputPath: requireOption(args, '--input'),
      outputPath: requireOption(args, '--output'),
      includeSchema: !hasFlag(args, '--no-schema'),
    });
    return;
  }

  throw new Error(usage(`Unknown command: ${command ?? '(missing)'}`));
}

function requireOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith('--')) {
    throw new Error(usage(`Missing required option: ${name}`));
  }
  return value;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function usage(message: string): string {
  return `${message}\n\nUsage:\n  karaoke-data-store import-json --input songs.json --db songs.sqlite\n  karaoke-data-store export-json --db songs.sqlite --output songs.json\n  karaoke-data-store export-d1-sql --input songs.json --output songs-d1.sql [--no-schema]`;
}

const entrypointPath = process.argv[1];
if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  runDataStoreCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
