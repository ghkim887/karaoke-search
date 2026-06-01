import { readFileSync } from 'node:fs';
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
      'wrangler d1 execute karaoke-songs --remote --file .wrangler/import/songs-d1.sql',
    );
  });

  it('keeps Wrangler local state and generated SQL dumps ignored', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');

    expect(gitignore).toContain('apps/worker/.wrangler/');
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
});
