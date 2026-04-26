import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL;

test.skip(
  !baseURL,
  'E2E_BASE_URL is not set; skipping axe-core a11y scan. Set E2E_BASE_URL to a deployed site to run this test.',
);

test('axe-core: home page has no detectable a11y violations', async ({ page }) => {
  await page.goto('');

  const result = await new AxeBuilder({ page }).analyze();

  if (result.violations.length > 0) {
    // Surface the violations so failures are diagnosable from CI logs.
    const lines = result.violations
      .map((v) => `  - [${v.id}] ${v.help} (impact: ${v.impact}) — ${v.helpUrl}`)
      .join('\n');
    console.error(`axe-core violations:\n${lines}`);
  }

  expect(result.violations).toEqual([]);
});
