import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER_ROOT = join(__dirname, '..');
const REPO_ROOT = join(WORKER_ROOT, '..', '..');

// Meta-assertions pinning the CI/deploy pipeline state after the Cloudflare
// deploy path (Workers + D1 + wrangler) was removed (2026-06-13). The only
// serving path is the self-hosted Node server over the SQLite database built
// by `sqlite:build`.
describe('CI pipeline pins', () => {
  it('exposes only self-host scripts and no Cloudflare tooling', () => {
    const packageJson = JSON.parse(readFileSync(join(WORKER_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.scripts['sqlite:build']).toContain('scripts/build-sqlite-db.mjs');
    expect(packageJson.scripts['serve:node']).toBe('node dist/node-server.js');

    // No wrangler/miniflare devDeps and no d1:/deploy: scripts may reappear
    // without a deliberate decision to re-add a Cloudflare deploy path.
    expect(packageJson.devDependencies).not.toHaveProperty('wrangler');
    expect(packageJson.devDependencies).not.toHaveProperty('miniflare');
    const scriptNames = Object.keys(packageJson.scripts);
    expect(scriptNames.filter((name) => name.startsWith('d1:'))).toEqual([]);
    expect(scriptNames.filter((name) => name.startsWith('deploy:'))).toEqual([]);
    expect(packageJson.scripts.test).not.toContain('d1-runtime');
  });

  it('keeps the worker scratch directories ignored', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');

    // sqlite:build writes its output under apps/worker/.build/ — it must stay
    // ignored so the self-host DB built on every PR is never committed.
    expect(gitignore).toContain('apps/worker/.build/');
    // The historical .wrangler/ output dir is retained so existing local
    // scratch state (cached crawl audits) stays ignored after the rename.
    expect(gitignore).toContain('apps/worker/.wrangler/');
  });

  it('gates the committed corpus through sqlite:build and keeps GitHub Pages disabled', () => {
    const deployWorkflowPath = join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');
    const ciWorkflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

    expect(existsSync(deployWorkflowPath)).toBe(false);
    expect(ciWorkflow).toContain('pull_request:');
    expect(ciWorkflow).toContain('pnpm lint');
    expect(ciWorkflow).toContain('pnpm typecheck');
    expect(ciWorkflow).toContain('pnpm test');
    expect(ciWorkflow).toContain('pnpm build');
    // The corpus gate: sqlite:build schema-validates every committed record
    // (validateSongCorpus) and proves the self-host DB builds on every PR.
    expect(ciWorkflow).toContain('pnpm --filter @karaoke/worker sqlite:build');
    expect(ciWorkflow).not.toContain('d1:verify-sql');
    expect(ciWorkflow).not.toContain('deploy:dry-run');
    expect(ciWorkflow).not.toContain('PUBLIC_KARAOKE_API_BASE_URL:');
    expect(readme).toContain('https://karaokedb.pages.dev/');
    expect(readme).toContain('GitHub Pages is intentionally disabled');
    // Fallback e2e gates: e2e workflows build the web app in fallback mode
    // and ci.yml actually runs the Playwright suite on PRs.
    expect(ciWorkflow).toContain('pnpm --filter @karaoke/web... build');
    expect(ciWorkflow).toContain('test:e2e');
  });
});
