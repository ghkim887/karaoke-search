import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSongDatabase } from '@karaoke/data-store';
import { beforeAll, describe, expect, it } from 'vitest';
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

  // A 1-record corpus builds with freelist=0 already, so it can't tell a real
  // VACUUM apart from a no-op. This corpus makes every title/artist share the
  // same characters, so their gram1 tokens blow past GRAM1_DF_CAP (500) and get
  // pruned mid-import — the deletes leave free pages the VACUUM must reclaim.
  function bulkCorpus(count) {
    const records = [];
    for (let index = 0; index < count; index += 1) {
      records.push({
        id: `bulk-${index}`,
        source_url: `https://example.com/bulk/${index}`,
        title_primary: `common shared title ${index}`,
        title_ko: `공통 제목 ${index}`,
        artist_primary: `common shared artist ${index}`,
        artist_ko: `공통 가수 ${index}`,
        karaoke_numbers: { tj: `${100000 + index}`, ky: null, joysound: null },
        crawled_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return records;
  }

  let rawResult;
  let vacuumResult;
  let rawPath;
  let vacuumPath;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-vacuum-'));
    const inputPath = join(dir, 'songs.json');
    rawPath = join(dir, 'raw.sqlite');
    vacuumPath = join(dir, 'vacuumed.sqlite');
    // 700 records reliably exceeds the df-cap for several shared gram1 tokens,
    // producing free pages in the un-vacuumed build (see probe: freelist ~53).
    writeFileSync(inputPath, JSON.stringify(bulkCorpus(700)), 'utf8');
    rawResult = await buildSqliteDb({ inputPath, outputPath: rawPath, vacuum: false });
    vacuumResult = await buildSqliteDb({ inputPath, outputPath: vacuumPath });
  });

  it('leaves reclaimable free pages when --no-vacuum is set', () => {
    expect(rawResult.vacuumed).toBe(false);
    expect(freelistCount(rawPath)).toBeGreaterThan(0);
  });

  it('compacts to zero free pages and a smaller file by default', () => {
    expect(vacuumResult.vacuumed).toBe(true);
    expect(freelistCount(vacuumPath)).toBe(0);
    expect(vacuumResult.bytes).toBeLessThan(rawResult.bytes);
  });

  it('changes only physical layout: the logical corpus is identical', () => {
    expect(dumpAllTables(vacuumPath)).toEqual(dumpAllTables(rawPath));
  });
});

describe('build-sqlite-db --search-hints', () => {
  it('indexes JOYSOUND ruby hints from a decision-log sidecar into title_hint tokens', async () => {
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
      // The search_hints table was retired 2026-07-08; hints now live only in
      // the search_tokens hint fields. The kana ruby yields kana grams...
      const kanaGram = db
        .prepare(
          `SELECT 1 FROM search_tokens
          WHERE song_id = 'joysound-190001' AND field = 'title_hint'
            AND kind = 'gram2' AND token = 'よる'`,
        )
        .get();
      expect(kanaGram).toBeDefined();
      // ...and a derived romaji term (P3), both under title_hint.
      const romajiTerm = db
        .prepare(
          `SELECT 1 FROM search_tokens
          WHERE song_id = 'joysound-190001' AND field = 'title_hint'
            AND kind = 'term' AND token = 'yorunikakeru'`,
        )
        .get();
      expect(romajiTerm).toBeDefined();
    } finally {
      db.close();
    }
  });
});

describe('build-sqlite-db release-hint guard', () => {
  // The release build materializes the committed curated sidecar into hint
  // tokens; this guards against silently re-unwiring hints (the original prod
  // bug) and against the retired dead schema resurfacing.
  const CURATED_HINTS = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../data/search-hints.jsonl',
  );

  const IDOLMASTER_RECORD = {
    id: 'tj-26670',
    source_url: 'https://example.com/tj/26670',
    title_primary: 'GO MY WAY!',
    title_ko: null,
    artist_primary: 'THE IDOLM@STER',
    artist_ko: null,
    karaoke_numbers: { tj: '26670', ky: null, joysound: null },
    crawled_at: '2026-02-01T00:00:00.000Z',
  };

  it('materializes artist_hint tokens from the curated sidecar; dead schema stays retired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-build-curated-'));
    const inputPath = join(dir, 'songs.json');
    const outputPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([IDOLMASTER_RECORD], null, 2)}\n`, 'utf8');

    await buildSqliteDb({ inputPath, outputPath, searchHintPaths: [CURATED_HINTS] });

    const db = openSongDatabase(outputPath);
    try {
      const hintTokens = db
        .prepare(
          `SELECT COUNT(*) AS count FROM search_tokens
          WHERE song_id = 'tj-26670' AND field = 'artist_hint'`,
        )
        .get();
      expect(Number(hintTokens.count)).toBeGreaterThan(0);

      const hintTables = db
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'search_hints'`,
        )
        .get();
      expect(Number(hintTables.count)).toBe(0);

      const columns = db
        .prepare('PRAGMA table_info(search_texts)')
        .all()
        .map((row) => row.name);
      expect(columns).not.toContain('text_norm');
    } finally {
      db.close();
    }
  });
});
