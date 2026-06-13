import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSongDatabase } from '@karaoke/data-store';
import { describe, expect, it } from 'vitest';
import { buildSqliteDb, parseBuildSqliteArgs } from '../scripts/build-sqlite-db.mjs';

const JOYSOUND_RECORD = {
  id: 'joysound-190001',
  source_url: 'https://example.com/joysound/190001',
  title_primary: '夜に駆ける',
  title_ko: null,
  artist_primary: 'YOASOBI',
  artist_ko: null,
  karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
  crawled_at: '2026-02-01T00:00:00.000Z',
};

describe('build-sqlite-db CLI args', () => {
  it('ignores the pnpm -- separator before script options', () => {
    expect(parseBuildSqliteArgs(['--', '--output', 'out.sqlite'])).toMatchObject({
      outputPath: 'out.sqlite',
    });
  });

  it('defaults to no hint sidecars', () => {
    expect(parseBuildSqliteArgs([])).toMatchObject({
      searchHintPaths: [],
    });
  });

  it('collects repeatable --search-hints paths', () => {
    expect(
      parseBuildSqliteArgs(['--search-hints', 'a.jsonl', '--search-hints', 'b.jsonl']),
    ).toMatchObject({
      searchHintPaths: ['a.jsonl', 'b.jsonl'],
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

describe('build-sqlite-db --search-hints', () => {
  it('indexes JOYSOUND ruby hints from a decision-log sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-hints-'));
    const inputPath = join(dir, 'songs.json');
    const hintsPath = join(dir, 'hints.jsonl');
    const outputPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([JOYSOUND_RECORD], null, 2)}\n`, 'utf8');
    writeFileSync(
      hintsPath,
      `${JSON.stringify({
        naviGroupId: '190001',
        selSongNo: '190-001',
        decision: 'admit',
        detail: { naviGroupId: '190001', songNameRuby: 'よるにかける' },
      })}\n`,
      'utf8',
    );

    await buildSqliteDb({ inputPath, outputPath, searchHintPaths: [hintsPath] });

    const db = openSongDatabase(outputPath);
    try {
      const ruby = db
        .prepare(
          `SELECT text_norm FROM search_hints
          WHERE song_id = 'joysound-190001' AND source = 'joysound_songNameRuby'`,
        )
        .get();
      expect(ruby).toEqual({ text_norm: 'よるにかける' });
      // The kana ruby also yields a derived romaji hint (P3).
      const derived = db
        .prepare(
          `SELECT text_norm FROM search_hints
          WHERE song_id = 'joysound-190001' AND source = 'derived_kana_romaji'`,
        )
        .get();
      expect(derived).toEqual({ text_norm: 'yorunikakeru' });
    } finally {
      db.close();
    }
  });
});
