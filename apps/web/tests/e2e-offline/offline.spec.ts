import { expect, test } from '@playwright/test';

/**
 * PWA / offline-fallback e2e (T4-6). Runs against a production build served by
 * `astro preview` in API mode (see playwright.offline.config.ts). The API base
 * (`/api`) has no worker behind it on the preview origin, so every API call
 * fails — the exact condition the local fallback is built for.
 *
 * The spec proves the whole offline story end-to-end:
 *   1. online: the service worker registers + takes control, and a failed API
 *      search transparently falls back to local results (warming the corpus
 *      into the runtime cache);
 *   2. offline: after a full reload with the network cut, the precached app
 *      shell still boots and local search still returns results.
 */

const KNOWN_QUERY = 'RADWIMPS'; // present in the crawled corpus (see search.spec.ts)

test.describe('offline fallback', () => {
  test.beforeEach(async ({ page }) => {
    // Every API request fails, so search must fall back to the local corpus.
    await page.route('**/api/**', (route) => route.abort());
  });

  test('registers a service worker and falls back to local search while online', async ({
    page,
  }) => {
    await page.goto('/');

    // The SW registers on window load; wait until it controls the page so the
    // subsequent songs.json fetch is intercepted + runtime-cached.
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 30_000,
    });

    const input = page.locator('.search-input');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    await input.fill(KNOWN_QUERY);

    // Local fallback produces results and the offline hint appears (NOT an error).
    await expect(page.locator('[data-testid="result-card"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.fallback-notice')).toBeVisible();
    await expect(page.locator('.error-state')).toHaveCount(0);
  });

  test('boots the app shell and searches locally after an offline reload', async ({
    page,
    context,
  }) => {
    // Online first pass: register the SW and warm the corpus cache via a search.
    await page.goto('/');
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 30_000,
    });
    await page.locator('.search-input').fill(KNOWN_QUERY);
    await expect(page.locator('[data-testid="result-card"]').first()).toBeVisible({
      timeout: 20_000,
    });

    // Cut the network and reload — the app must boot entirely from cache.
    await context.setOffline(true);
    await page.reload();

    // App shell rendered from the precache (header + usable search box).
    await expect(page.locator('.site-title')).toBeVisible();
    const input = page.locator('.search-input');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // Local search still works with no network, from the cached corpus.
    await input.fill(KNOWN_QUERY);
    await expect(page.locator('[data-testid="result-card"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.fallback-notice')).toBeVisible();

    await context.setOffline(false);
  });
});
