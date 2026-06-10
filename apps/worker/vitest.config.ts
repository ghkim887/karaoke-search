import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // d1-runtime.test.ts boots the built worker bundle (dist/index.js) inside
    // Miniflare, so it needs a `tsc -b` of this package first. It runs via the
    // dedicated `test:d1-runtime` script (vitest.config.d1-runtime.ts), which
    // does that pre-build. Everything else is glob-discovered here so new
    // test files can never be silently dropped.
    exclude: [...configDefaults.exclude, 'test/d1-runtime.test.ts'],
  },
});
