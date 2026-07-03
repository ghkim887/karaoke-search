import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve sibling workspace packages from source so `vitest run` does not
  // require a prebuilt dist/. Kept in sync with tsconfig.typecheck.json paths.
  resolve: {
    alias: {
      '@karaoke/schema': fileURLToPath(new URL('../../packages/schema/src/index.ts', import.meta.url)),
      '@karaoke/search': fileURLToPath(new URL('../../packages/search/src/index.ts', import.meta.url)),
      '@karaoke/data-store': fileURLToPath(
        new URL('../../packages/data-store/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    // All tests are glob-discovered so new test files can never be silently
    // dropped.
  },
});
