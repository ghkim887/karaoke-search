import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;

test.skip(
  !baseURL,
  'E2E_BASE_URL is not set; skipping karaoke search smoke test. Set E2E_BASE_URL to a deployed site to run this test.',
);

test('search returns a result card with at least one karaoke number', async ({ page }) => {
  await page.goto('/');

  const searchBox = page.getByLabel('가라오케 검색');
  await expect(searchBox).toBeVisible();

  // "RADWIMPS" is in the v1 sample data; confirm before changing to a different known-present artist.
  await searchBox.fill('RADWIMPS');

  const firstCard = page.locator('[data-testid="result-card"]').first();
  await expect(firstCard).toBeVisible();

  const badges = firstCard.locator(
    '[data-testid="badge-tj"], [data-testid="badge-ky"], [data-testid="badge-joysound"]',
  );
  await expect(badges).toHaveCount(3);

  // At least one of the three badges should contain digits. Em-dash placeholders
  // for missing values won't match /\d/, so this naturally filters them out.
  await expect(badges.filter({ hasText: /\d/ }).first()).toBeVisible();
});
