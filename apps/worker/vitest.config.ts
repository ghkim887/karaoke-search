import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // All tests are glob-discovered so new test files can never be silently
    // dropped.
  },
});
