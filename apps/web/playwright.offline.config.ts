import { defineConfig, devices } from '@playwright/test';

/**
 * Dedicated config for the PWA / offline-fallback e2e (T4-6). Separate from the
 * default `playwright.config.ts` (which smoke-tests a deployed URL via
 * `E2E_BASE_URL`) because these specs need:
 *   - a service worker, which only registers over http://localhost or https;
 *   - a production build in API mode (`PUBLIC_KARAOKE_API_BASE_URL`), so the
 *     API→local fallback path is exercised;
 *   - `contextOptions.serviceWorkers: 'allow'` and a real `astro preview` server.
 *
 * The webServer builds in API mode then serves the built `dist/`. The dummy API
 * base (`/api`) resolves to the preview origin, where the worker does not exist,
 * so requests fail and the local fallback engages — exactly the production
 * degraded-network scenario.
 */
const PORT = 4321;

export default defineConfig({
  testDir: 'tests/e2e-offline',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Invoke the Astro CLI via `node` directly: Playwright spawns this through
    // the platform shell, where the `pnpm` shim is not guaranteed to be on PATH
    // (it is provided via corepack), but `node` always is.
    command: `node ./node_modules/astro/astro.js build && node ./node_modules/astro/astro.js preview --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    env: { PUBLIC_KARAOKE_API_BASE_URL: '/api' },
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
