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

  it('vacuums by default and skips on --no-vacuum', () => {
    expect(parseBuildSqliteArgs([])).toMatchObject({ vacuum: true });
    expect(parseBuildSqliteArgs(['--no-vacuum'])).toMatchObject({ vacuum: false });
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

describe('build-sqlite-db VACUUM', () => {
  function freelistCount(dbPath) {
    const db = openSongDatabase(dbPath);
    try {
      return Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
    } finally {
      db.close();
    }
  }

  // Logical dump of every user table (plus ANALYZE's sqlite_stat1), each row set
  // ordered deterministically, so VACUUM's physical-only rewrite can be proven
  // to leave the corpus byte-for-byte identical.
  function dumpAllTables(dbPath) {
    const db = openSongDatabase(dbPath);
    try {
      const tables = db
        .prepare(
          `SELECT name FROM sqlite_schema
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           UNION ALL SELECT 'sqlite_stat1' WHERE EXISTS
             (SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1')
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      const dump = {};
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        dump[table] = rows.map((row) => JSON.stringify(row)).sort();
      }
      return dump;
    } finally {
      db.close();
    }
  }

  it('produces a compacted database (freelist_count = 0) by default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-vacuum-'));
    const inputPath = join(dir, 'songs.json');
    const outputPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([JOYSOUND_RECORD], null, 2)}\n`, 'utf8');

    const result = await buildSqliteDb({ inputPath, outputPath });

    expect(result.vacuumed).toBe(true);
    expect(freelistCount(outputPath)).toBe(0);
  });

  it('skips VACUUM when --no-vacuum is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-novacuum-'));
    const inputPath = join(dir, 'songs.json');
    const outputPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([JOYSOUND_RECORD], null, 2)}\n`, 'utf8');

    const result = await buildSqliteDb({ inputPath, outputPath, vacuum: false });

    expect(result.vacuumed).toBe(false);
  });

  it('changes only physical layout: the logical corpus is identical', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-vacuum-eq-'));
    const inputPath = join(dir, 'songs.json');
    const vacuumedPath = join(dir, 'vacuumed.sqlite');
    const rawPath = join(dir, 'raw.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([JOYSOUND_RECORD], null, 2)}\n`, 'utf8');

    await buildSqliteDb({ inputPath, outputPath: vacuumedPath });
    await buildSqliteDb({ inputPath, outputPath: rawPath, vacuum: false });

    expect(dumpAllTables(vacuumedPath)).toEqual(dumpAllTables(rawPath));
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
