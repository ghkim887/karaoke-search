import { describe, expect, it } from 'vitest';
import { parseBuildSqliteArgs } from '../scripts/build-sqlite-db.mjs';

describe('build-sqlite-db CLI args', () => {
  it('ignores the pnpm -- separator before script options', () => {
    expect(parseBuildSqliteArgs(['--', '--output', 'out.sqlite'])).toMatchObject({
      outputPath: 'out.sqlite',
    });
  });
});
