import { defineConfig } from 'vitest/config';

// Dedicated config for the Miniflare runtime test, which is excluded from the
// default config because it requires the worker bundle (dist/index.js) to be
// built first. Invoked by the `test:d1-runtime` script after `tsc -b`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/d1-runtime.test.ts'],
  },
});
