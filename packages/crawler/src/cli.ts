#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters as registeredAdapters } from './adapters/index.js';
import { runPipeline } from './pipeline.js';

const HELP = `karaoke-crawl — run registered source adapters and emit songs.json

Usage:
  karaoke-crawl [--limit <n>] [--source <slug>]... [--out <path>]
                [--conflicts-out <path>]

Options:
  --limit <n>      Per-source page cap (e.g. artist pages for the blog
                   adapter). 0 or omitted means no cap.
  --source <slug>  Restrict to adapters whose name matches <slug>. Repeatable;
                   may also be a comma-separated list. If omitted, all
                   registered adapters run in registration order.
  --out <path>     Output JSON path. Resolved relative to the repo root
                   (the directory containing pnpm-workspace.yaml). Defaults
                   to apps/web/public/data/songs.json.
  --conflicts-out <path>
                   Optional path for the Tier-B merge-conflict summary JSON
                   ({ total, sample }). When set, the file is written even
                   if total=0 (so the workflow can branch on its presence).
                   Note: Tier C cross-source merges are excluded from the
                   headline 'total' count, but they ARE included in the
                   per-entry 'sample' list for forensic inspection.
  --help           Print this message and exit 0.
`;

interface ParsedArgs {
  limit: number;
  sources: string[];
  out: string;
  conflictsOut: string | null;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    limit: 0,
    sources: [],
    out: 'apps/web/public/data/songs.json',
    conflictsOut: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Tolerate a literal `--` separator (pnpm convention) instead of
    // treating it as an unknown flag. Continue parsing the rest of argv.
    if (arg === '--') {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg === '--limit') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--limit requires a value');
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--limit must be a non-negative integer, got: ${next}`);
      }
      out.limit = n;
      continue;
    }
    if (arg === '--source') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--source requires a value');
      for (const slug of next.split(',')) {
        const trimmed = slug.trim();
        if (trimmed) out.sources.push(trimmed);
      }
      continue;
    }
    if (arg === '--out') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--out requires a value');
      out.out = next;
      continue;
    }
    if (arg === '--conflicts-out') {
      const next = argv[++i];
      if (next === undefined) throw new Error('--conflicts-out requires a value');
      out.conflictsOut = next;
      continue;
    }
    throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Walk up until we find pnpm-workspace.yaml; cap at filesystem root.
  for (let i = 0; i < 32; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to cwd if walking failed (e.g., when run outside the monorepo).
  return process.cwd();
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }

  const repoRoot = findRepoRoot();
  const outPath = isAbsolute(parsed.out) ? parsed.out : resolve(repoRoot, parsed.out);
  const conflictsOutPath = parsed.conflictsOut
    ? isAbsolute(parsed.conflictsOut)
      ? parsed.conflictsOut
      : resolve(repoRoot, parsed.conflictsOut)
    : undefined;

  const selected =
    parsed.sources.length === 0
      ? registeredAdapters
      : registeredAdapters.filter((a) => parsed.sources.includes(a.name));

  const pipelineOpts: Parameters<typeof runPipeline>[0] = {
    adapters: selected,
    outPath,
    ...(parsed.limit > 0 ? { limit: parsed.limit } : {}),
    ...(conflictsOutPath ? { conflictsOutPath } : {}),
  };
  const { written, conflicts } = await runPipeline(pipelineOpts);
  process.stdout.write(`wrote ${written} records to ${outPath}\n`);
  // Fix B.1 (2026-05-01): the headline "merge conflicts" count excludes
  // `tier_c_merge` entries — those are successful soft-merges flagged for
  // visibility, not disagreements. Per-cluster Tier C detail still lives in
  // the conflicts-out JSON for downstream readers.
  const headlineConflicts = conflicts.filter((c) => c.field !== 'tier_c_merge');
  if (headlineConflicts.length > 0) {
    process.stdout.write(`merge conflicts: ${headlineConflicts.length}\n`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
