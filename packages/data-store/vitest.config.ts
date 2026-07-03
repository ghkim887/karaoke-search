import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve sibling workspace packages from source so `vitest run` does not
// require a prebuilt dist/. Typecheck uses the matching `paths` in
// tsconfig.typecheck.json; keep the two in sync when dependency edges change.
export default defineConfig({
  resolve: {
    alias: {
      '@karaoke/schema': fileURLToPath(new URL('../schema/src/index.ts', import.meta.url)),
      '@karaoke/search': fileURLToPath(new URL('../search/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
