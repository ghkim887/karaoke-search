import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSqliteDb, parseBuildSqliteArgs } from '../scripts/build-sqlite-db.mjs';

describe('build-sqlite-db CLI args', () => {
  it('ignores the pnpm -- separator before script options', () => {
    expect(parseBuildSqliteArgs(['--', '--output', 'out.sqlite'])).toMatchObject({
      outputPath: 'out.sqlite',
    });
  });
});

describe('build-sqlite-db empty-corpus guard', () => {
  // Requires @karaoke/data-store dist/ — the worker `test` script builds it
  // before vitest runs (same prerequisite as the sqlite:build script itself).
  it('fails on a 0-record corpus and leaves no database behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-sqlite-'));
    const inputPath = join(dir, 'empty.json');
    const outputPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, '[]\n', 'utf8');

    await expect(buildSqliteDb({ inputPath, outputPath })).rejects.toThrow(
      /Refusing to build an empty database: 0 songs/,
    );
    expect(existsSync(outputPath)).toBe(false);
  });

  it('reports the song count for a non-empty corpus', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-sqlite-'));
    const inputPath = join(dir, 'one.json');
    const outputPath = join(dir, 'songs.sqlite');
    const record = {
      id: 'blog-1',
      source_url: 'https://example.com/blog/1',
      title_primary: 'Yoru ni Kakeru',
      title_ko: null,
      artist_primary: 'YOASOBI',
      artist_ko: null,
      karaoke_numbers: { tj: '68000', ky: null, joysound: null },
      crawled_at: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(inputPath, `${JSON.stringify([record], null, 2)}\n`, 'utf8');

    const result = await buildSqliteDb({ inputPath, outputPath });

    expect(result.songCount).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
  });
});
