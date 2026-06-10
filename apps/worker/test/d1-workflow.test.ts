import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER_ROOT = join(__dirname, '..');
const REPO_ROOT = join(WORKER_ROOT, '..', '..');
const PLACEHOLDER_DATABASE_ID = '00000000-0000-0000-0000-000000000000';

async function importWorkerScript<T>(scriptName: string): Promise<T> {
  return import(pathToFileURL(join(WORKER_ROOT, 'scripts', scriptName)).href) as Promise<T>;
}

describe('D1 import workflow', () => {
  it('exposes local import scripts and guarded remote import scripts', () => {
    const packageJson = JSON.parse(readFileSync(join(WORKER_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.devDependencies.wrangler).toMatch(/^\^/);
    expect(packageJson.scripts['d1:export-sql']).toContain('scripts/export-d1-sql.mjs');
    expect(packageJson.scripts['d1:migrate:local']).toBe(
      'wrangler d1 migrations apply karaoke-songs --local',
    );
    expect(packageJson.scripts['d1:import:local']).toBe(
      'corepack pnpm run d1:export-sql && wrangler d1 execute karaoke-songs --local --file .wrangler/import/songs-d1.sql',
    );
    expect(packageJson.scripts['d1:migrate:remote']).toContain('scripts/guard-remote-d1.mjs');
    expect(packageJson.scripts['d1:import:remote']).toContain('scripts/guard-remote-d1.mjs');
    expect(packageJson.scripts['d1:import:remote']).toContain(
      'scripts/import-d1-remote-chunked.mjs',
    );
    expect(packageJson.scripts['d1:import:remote']).not.toContain(
      'wrangler d1 execute karaoke-songs --remote --file .wrangler/import/songs-d1.sql',
    );
    expect(packageJson.scripts['d1:verify-sql']).toContain('scripts/report-d1-sql-metrics.mjs');
    expect(packageJson.scripts['deploy:dry-run']).toBe('wrangler deploy --dry-run');
    expect(packageJson.scripts['deploy:remote']).toBe(
      'node scripts/guard-remote-d1.mjs && wrangler deploy',
    );
  });

  it('keeps Wrangler local state and generated SQL dumps ignored', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');

    expect(gitignore).toContain('apps/worker/.wrangler/');
  });

  it('requires CI deployment guards and hard-gates Pages E2E before deploy', () => {
    const deployWorkflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'deploy.yml'),
      'utf8',
    );
    const ciWorkflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(deployWorkflow).not.toContain('continue-on-error: true');
    expect(deployWorkflow).toMatch(/deploy:\r?\n(?:.|\r?\n)*?needs:\s*\[build,\s*e2e\]/);
    expect(ciWorkflow).toContain('pull_request:');
    expect(ciWorkflow).toContain('pnpm lint');
    expect(ciWorkflow).toContain('pnpm typecheck');
    expect(ciWorkflow).toContain('pnpm test');
    expect(ciWorkflow).toContain('pnpm build');
    expect(ciWorkflow).toContain('pnpm --filter @karaoke/worker d1:verify-sql');
    expect(ciWorkflow).toContain('pnpm --filter @karaoke/worker deploy:dry-run');
    expect(deployWorkflow).toContain(
      'PUBLIC_KARAOKE_API_BASE_URL: https://karaoke-search-api.ghkim887.workers.dev',
    );
    // Fallback e2e gates: the API-first env var must be SET (`NAME:` with a
    // colon — comments mention the bare name) exactly once in deploy.yml, on
    // the build job only. The e2e jobs in BOTH workflows build the web app in
    // fallback mode (no API base URL) so neither gate depends on a live
    // Worker, and ci.yml must actually run the Playwright suite on PRs.
    expect(deployWorkflow.match(/PUBLIC_KARAOKE_API_BASE_URL:/g)).toHaveLength(1);
    expect(deployWorkflow).toContain('pnpm --filter @karaoke/web... build');
    expect(ciWorkflow).toContain('pnpm --filter @karaoke/web... build');
    expect(ciWorkflow).toContain('test:e2e');
  });

  it('reports D1 SQL metrics and fails statements over D1 limits', async () => {
    const { assertD1SqlMetricsWithinLimits, summarizeD1SqlText } = await importWorkerScript<{
      assertD1SqlMetricsWithinLimits(
        metrics: { maxStatementBytes: number },
        limits?: { maxStatementBytes?: number },
      ): void;
      summarizeD1SqlText(sqlText: string): {
        totalBytes: number;
        statementCount: number;
        maxStatementBytes: number;
      };
    }>('report-d1-sql-metrics.mjs');

    const sqlText = "DELETE FROM songs;\nINSERT INTO songs (id) VALUES ('a');\n";

    const metrics = summarizeD1SqlText(sqlText);

    expect(metrics.statementCount).toBe(2);
    expect(metrics.totalBytes).toBe(Buffer.byteLength(sqlText));
    expect(metrics.maxStatementBytes).toBeGreaterThan(0);
    expect(() => assertD1SqlMetricsWithinLimits({ maxStatementBytes: 100001 })).toThrow(
      /exceeds.*100000/,
    );
  });

  it('defaults SQL export to the production corpus and ignored scratch output without schema', async () => {
    const { parseExportArgs } = await importWorkerScript<{
      parseExportArgs(argv: readonly string[]): {
        inputPath: string;
        outputPath: string;
        includeSchema: boolean;
      };
    }>('export-d1-sql.mjs');

    expect(parseExportArgs([])).toEqual({
      inputPath: join(WORKER_ROOT, '..', 'web', 'public', 'data', 'songs.json'),
      outputPath: join(WORKER_ROOT, '.wrangler', 'import', 'songs-d1.sql'),
      includeSchema: false,
    });
    expect(
      parseExportArgs(['--input', 'fixture.json', '--output', 'fixture.sql', '--schema']),
    ).toEqual({
      inputPath: 'fixture.json',
      outputPath: 'fixture.sql',
      includeSchema: true,
    });
  });

  it('refuses remote D1 commands while wrangler.toml still has the placeholder database id', async () => {
    const { assertRemoteD1WorkflowAllowed } = await importWorkerScript<{
      assertRemoteD1WorkflowAllowed(args: {
        configText: string;
        env: Record<string, string>;
      }): void;
    }>('guard-remote-d1.mjs');

    expect(() =>
      assertRemoteD1WorkflowAllowed({
        configText: `database_id = "${PLACEHOLDER_DATABASE_ID}"`,
        env: { KARAOKE_D1_REMOTE_OK: '1' },
      }),
    ).toThrow(/placeholder database_id/);
  });

  it('requires an explicit environment confirmation before remote D1 mutation', async () => {
    const { assertRemoteD1WorkflowAllowed } = await importWorkerScript<{
      assertRemoteD1WorkflowAllowed(args: {
        configText: string;
        env: Record<string, string>;
      }): void;
    }>('guard-remote-d1.mjs');

    expect(() =>
      assertRemoteD1WorkflowAllowed({
        configText: 'database_id = "11111111-2222-3333-4444-555555555555"',
        env: {},
      }),
    ).toThrow(/KARAOKE_D1_REMOTE_OK=1/);

    expect(() =>
      assertRemoteD1WorkflowAllowed({
        configText: 'database_id = "11111111-2222-3333-4444-555555555555"',
        env: { KARAOKE_D1_REMOTE_OK: '1' },
      }),
    ).not.toThrow();
  });

  it('resolves Wrangler through its package entrypoint before Windows command fallback', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'karaoke wrangler bin '));
    try {
      const { quoteWindowsCommandArg, wranglerInvocation } = await importWorkerScript<{
        quoteWindowsCommandArg(arg: string): string;
        wranglerInvocation(
          args: readonly string[],
          options?: {
            platform?: NodeJS.Platform;
            cwd?: string;
            env?: Record<string, string>;
            node?: string;
          },
        ): { command: string; args: readonly string[] };
      }>('import-d1-remote-chunked.mjs');
      const wranglerBinDir = join(tempRoot, 'node_modules', 'wrangler', 'bin');
      mkdirSync(wranglerBinDir, { recursive: true });
      const wranglerEntrypoint = join(wranglerBinDir, 'wrangler.js');
      writeFileSync(wranglerEntrypoint, 'console.log("stub wrangler")\n', 'utf8');

      expect(
        wranglerInvocation(['--file', join(tempRoot, 'chunk file.sql')], {
          platform: 'win32',
          cwd: tempRoot,
          env: { ComSpec: 'cmd.exe' },
          node: 'node.exe',
        }),
      ).toEqual({
        command: 'node.exe',
        args: [wranglerEntrypoint, '--file', join(tempRoot, 'chunk file.sql')],
      });

      rmSync(wranglerEntrypoint, { force: true });
      expect(
        wranglerInvocation(['--file', join(tempRoot, 'chunk file.sql')], {
          platform: 'win32',
          cwd: tempRoot,
          env: { ComSpec: 'cmd.exe' },
        }),
      ).toEqual({
        command: 'cmd.exe',
        args: [
          '/d',
          '/s',
          '/c',
          ['corepack', 'pnpm', 'exec', 'wrangler', '--file', join(tempRoot, 'chunk file.sql')]
            .map(quoteWindowsCommandArg)
            .join(' '),
        ],
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('splits remote D1 import SQL into small chunks and rejects oversized statements', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'karaoke-d1-chunks-'));
    try {
      const sqlPath = join(tempRoot, 'input.sql');
      const chunksDir = join(tempRoot, 'chunks');
      const oversizedChunksDir = join(tempRoot, 'oversized-chunks');
      writeFileSync(
        sqlPath,
        [
          'DELETE FROM songs;',
          'INSERT INTO songs (id)',
          "VALUES ('a');",
          "INSERT INTO songs (id) VALUES ('b; still string literal');",
          '',
        ].join('\n'),
        'utf8',
      );

      const moduleUrl = pathToFileURL(join(WORKER_ROOT, 'scripts', 'import-d1-remote-chunked.mjs'));
      const probe = String.raw`
        const { assertRemoteChunkedImportAllowed, splitSqlIntoChunks } = await import(process.env.MODULE_URL);
        let guardMessage = '';
        try {
          assertRemoteChunkedImportAllowed({});
        } catch (error) {
          guardMessage = error instanceof Error ? error.message : String(error);
        }
        assertRemoteChunkedImportAllowed({ KARAOKE_D1_REMOTE_PARTIAL_REPLACE_OK: '1' });
        const plan = splitSqlIntoChunks({
          sqlPath: process.env.SQL_PATH,
          chunksDir: process.env.CHUNKS_DIR,
          maxBytes: 80,
        });
        let oversizedMessage = '';
        try {
          splitSqlIntoChunks({
            sqlPath: process.env.SQL_PATH,
            chunksDir: process.env.OVERSIZED_CHUNKS_DIR,
            maxBytes: 10,
          });
        } catch (error) {
          oversizedMessage = error instanceof Error ? error.message : String(error);
        }
        await import('node:fs').then(({ writeFileSync }) => {
          writeFileSync(process.env.TRUNCATED_SQL_PATH, 'DELETE FROM songs', 'utf8');
          writeFileSync(process.env.TRANSACTION_SQL_PATH, 'BEGIN;\nDELETE FROM songs;\nCOMMIT;\n', 'utf8');
        });
        let truncatedMessage = '';
        try {
          splitSqlIntoChunks({
            sqlPath: process.env.TRUNCATED_SQL_PATH,
            chunksDir: process.env.TRUNCATED_CHUNKS_DIR,
            maxBytes: 80,
          });
        } catch (error) {
          truncatedMessage = error instanceof Error ? error.message : String(error);
        }
        let transactionMessage = '';
        try {
          splitSqlIntoChunks({
            sqlPath: process.env.TRANSACTION_SQL_PATH,
            chunksDir: process.env.TRANSACTION_CHUNKS_DIR,
            maxBytes: 80,
          });
        } catch (error) {
          transactionMessage = error instanceof Error ? error.message : String(error);
        }
        console.log(JSON.stringify({ guardMessage, plan, oversizedMessage, truncatedMessage, transactionMessage }));
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MODULE_URL: moduleUrl.href,
          SQL_PATH: sqlPath,
          CHUNKS_DIR: chunksDir,
          OVERSIZED_CHUNKS_DIR: oversizedChunksDir,
          TRUNCATED_SQL_PATH: join(tempRoot, 'truncated.sql'),
          TRUNCATED_CHUNKS_DIR: join(tempRoot, 'truncated-chunks'),
          TRANSACTION_SQL_PATH: join(tempRoot, 'transaction.sql'),
          TRANSACTION_CHUNKS_DIR: join(tempRoot, 'transaction-chunks'),
        },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const { guardMessage, plan, oversizedMessage, truncatedMessage, transactionMessage } =
        JSON.parse(result.stdout) as {
          guardMessage: string;
          truncatedMessage: string;
          transactionMessage: string;
          plan: {
            sourceBytes: number;
            sourceStatements: number;
            chunks: Array<{ path: string; statements: number; bytes: number }>;
          };
          oversizedMessage: string;
        };

      expect(guardMessage).toMatch(/not atomic/);
      expect(plan.sourceStatements).toBe(3);
      expect(plan.sourceBytes).toBeGreaterThan(0);
      expect(plan.chunks.length).toBeGreaterThan(1);
      expect(plan.chunks.every((chunk) => chunk.bytes <= 80)).toBe(true);
      const firstChunk = readFileSync(plan.chunks[0]?.path ?? '', 'utf8');
      expect(firstChunk).toContain('DELETE FROM songs;');
      expect(firstChunk).toContain("INSERT INTO songs (id)\nVALUES ('a');");
      expect(oversizedMessage).toMatch(/exceeding remote chunk limit/);
      expect(truncatedMessage).toMatch(/terminating semicolon/);
      expect(transactionMessage).toMatch(/transaction control statements/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
