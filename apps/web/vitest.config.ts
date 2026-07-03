import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve sibling workspace packages from source so `vitest run` does not
  // require a prebuilt dist/. Kept in sync with the tsconfig paths.
  resolve: {
    alias: {
      '@karaoke/schema': fileURLToPath(
        new URL('../../packages/schema/src/index.ts', import.meta.url),
      ),
      '@karaoke/search': fileURLToPath(
        new URL('../../packages/search/src/index.ts', import.meta.url),
      ),
      // Resolved from source (no prebuilt dist/) so the cross-path search-parity
      // gate (search-parity.golden.test.ts) can drive the worker's SQLite path
      // and build an in-memory corpus. Test-only; no production module imports these.
      '@karaoke/data-store': fileURLToPath(
        new URL('../../packages/data-store/src/index.ts', import.meta.url),
      ),
      '@karaoke/worker': fileURLToPath(new URL('../worker/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'tests/e2e/**',
    ],
  },
});
