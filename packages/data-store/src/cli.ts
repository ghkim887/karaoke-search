#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  type DeltaPatchTokenStatMode,
  type PatchSongsJsonDeltaArgs,
  exportSongsJson,
  importSongsJson,
  patchSongsJsonDelta,
} from './index.js';

export function runDataStoreCli(argv: readonly string[]): void {
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

  if (command === 'patch-json-delta') {
    const patchArgs: PatchSongsJsonDeltaArgs = {
      basePath: requireOption(args, '--base'),
      candidatePath: requireOption(args, '--candidate'),
      dbPath: requireOption(args, '--db'),
      searchHintPaths: readRepeatedOption(args, '--search-hints'),
      checkDbMatchesBase: !hasFlag(args, '--skip-db-base-check'),
      dryRun: hasFlag(args, '--dry-run'),
    };
    const manifestPath = readOptionalOption(args, '--manifest');
    if (manifestPath !== undefined) {
      patchArgs.manifestPath = manifestPath;
    }
    const maxTouchedSongs = readOptionalNumber(args, '--max-touched-songs');
    if (maxTouchedSongs !== undefined) {
      patchArgs.maxTouchedSongs = maxTouchedSongs;
    }
    const maxTouchedRatio = readOptionalNumber(args, '--max-touched-ratio');
    if (maxTouchedRatio !== undefined) {
      patchArgs.maxTouchedRatio = maxTouchedRatio;
    }
    const tokenStatMode = readTokenStatMode(args);
    if (tokenStatMode !== undefined) {
      patchArgs.tokenStatMode = tokenStatMode;
    }
    patchSongsJsonDelta(patchArgs);
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

function readOptionalOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) {
    return undefined;
  }
  if (value.startsWith('--')) {
    throw new Error(usage(`Missing value for option: ${name}`));
  }
  return value;
}

function readRepeatedOption(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(usage(`Missing value for option: ${name}`));
    }
    values.push(value);
  }
  return values;
}

function readOptionalNumber(args: readonly string[], name: string): number | undefined {
  const value = readOptionalOption(args, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(usage(`Invalid numeric value for ${name}: ${value}`));
  }
  return parsed;
}

function readTokenStatMode(args: readonly string[]): DeltaPatchTokenStatMode | undefined {
  const value = readOptionalOption(args, '--token-stats');
  if (value === undefined) {
    return undefined;
  }
  if (value !== 'affected' && value !== 'all') {
    throw new Error(usage(`Invalid --token-stats value: ${value}`));
  }
  return value;
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function usage(message: string): string {
  return `${message}\n\nUsage:\n  karaoke-data-store import-json --input songs.json --db songs.sqlite\n  karaoke-data-store export-json --db songs.sqlite --output songs.json\n  karaoke-data-store patch-json-delta --base base.json --candidate candidate.json --db songs.sqlite [--manifest patch.json] [--dry-run] [--max-touched-songs N] [--max-touched-ratio R] [--token-stats affected|all] [--search-hints hints.jsonl ...]`;
}

const entrypointPath = process.argv[1];
if (entrypointPath !== undefined && import.meta.url === pathToFileURL(entrypointPath).href) {
  try {
    runDataStoreCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
