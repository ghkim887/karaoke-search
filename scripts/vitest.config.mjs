import { defineConfig } from 'vitest/config';

// Glob-based discovery: any *.test.mjs committed under scripts/ runs
// automatically in `pnpm -r test` — no hand-listing in any package.json.
// (Tests were previously enumerated by hand in @karaoke/crawler's test
// script, which silently dropped newly committed test files.)
export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.mjs'],
  },
});
