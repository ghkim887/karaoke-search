import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SearchHintInput,
  createSongDatabase,
  exportSongs,
  importSongs,
  importSongsJson,
  openSongDatabase,
  parseSearchHintFile,
} from '../src/index.js';

const openDatabases: Array<{ close(): void }> = [];

function openMemoryDb() {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  return db;
}

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'karaoke-hints-'));
  const path = join(dir, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

// A kanji-only canonical title whose ruby reading (よるにかける) is supplied as a
// SEARCH-ONLY hint. The canonical record never carries the reading.
const YORU_RECORD: SongRecord = {
  id: 'joysound-190001',
  source_url: 'https://example.com/joysound/190001',
  title_primary: '夜に駆ける',
  title_ko: null,
  artist_primary: 'YOASOBI',
  artist_ko: null,
  karaoke_numbers: { tj: null, ky: null, joysound: '190001' },
  crawled_at: '2026-02-01T00:00:00.000Z',
};

describe('P1 search_hints sidecar foundation', () => {
  it('creates a search_hints table with provenance columns', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'search_hints'`)
      .all() as unknown as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(['search_hints']);

    const columns = db.prepare('PRAGMA table_info(search_hints)').all() as unknown as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      'song_id',
      'field',
      'source',
      'text_norm',
      'text_compact',
      'weight',
      'provider_mask',
      'confidence',
    ]);
  });

  it('stores supplied hints in search_hints with provenance preserved', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    const hints: SearchHintInput[] = [
      {
        songId: 'joysound-190001',
        field: 'title',
        text: 'よるにかける',
        source: 'joysound_songNameRuby',
        confidence: 'high',
      },
    ];
    importSongs(db, [YORU_RECORD], { searchHints: hints });

    const rows = db
      .prepare(
        `SELECT song_id, field, source, text_norm, text_compact, provider_mask, confidence
        FROM search_hints
        WHERE source = 'joysound_songNameRuby'`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        song_id: 'joysound-190001',
        field: 'title',
        source: 'joysound_songNameRuby',
        text_norm: 'よるにかける',
        text_compact: 'よるにかける',
        provider_mask: 4,
        confidence: 'high',
      },
    ]);
  });

  it('indexes hint tokens into search_tokens under a hint field at a low weight', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [YORU_RECORD], {
      searchHints: [
        {
          songId: 'joysound-190001',
          field: 'title',
          text: 'よるにかける',
          source: 'joysound_songNameRuby',
          confidence: 'high',
        },
      ],
    });

    const hintTokens = db
      .prepare(
        `SELECT DISTINCT field, weight, provider_mask
        FROM search_tokens
        WHERE song_id = 'joysound-190001' AND field = 'title_hint'`,
      )
      .all() as unknown as Array<{ field: string; weight: number; provider_mask: number }>;
    expect(hintTokens).toEqual([{ field: 'title_hint', weight: 1, provider_mask: 4 }]);

    // The kana gram must be present so kana recall can match the canonical row.
    const gram = db
      .prepare(
        `SELECT 1 FROM search_tokens
        WHERE song_id = 'joysound-190001' AND field = 'title_hint'
          AND kind = 'gram2' AND token = 'よる'`,
      )
      .get();
    expect(gram).toBeDefined();

    // Hints must NOT receive the canonical exact-match boost path.
    const exact = db
      .prepare(`SELECT COUNT(*) AS count FROM search_texts WHERE text_compact = 'よるにかける'`)
      .get() as unknown as { count: number };
    expect(exact.count).toBe(0);
  });

  it('never leaks hints into exported SongRecords', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [YORU_RECORD], {
      searchHints: [
        {
          songId: 'joysound-190001',
          field: 'title',
          text: 'よるにかける',
          source: 'joysound_songNameRuby',
          confidence: 'high',
        },
      ],
    });

    const exported = exportSongs(db);
    expect(exported).toEqual([YORU_RECORD]);
    expect(JSON.stringify(exported)).toBe(JSON.stringify([YORU_RECORD]));
  });

  it('imports normally with no hints and leaves search_hints empty', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [YORU_RECORD]);

    const count = db.prepare('SELECT COUNT(*) AS count FROM search_hints').get() as unknown as {
      count: number;
    };
    expect(count.count).toBe(0);
    expect(exportSongs(db)).toEqual([YORU_RECORD]);
  });

  it('upgrades a legacy database whose search_tokens lacks the hint field', () => {
    const db = openMemoryDb();
    // Simulate a pre-hints schema: search_tokens CHECK without the *_hint fields
    // and no search_hints table at all.
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(
      `CREATE TABLE songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0, crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT);
       CREATE TABLE karaoke_numbers (song_id TEXT NOT NULL, provider TEXT NOT NULL, number TEXT, number_key TEXT, PRIMARY KEY (song_id, provider));
       CREATE TABLE artist_aliases (song_id TEXT NOT NULL, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position));
       CREATE TABLE search_texts (song_id TEXT NOT NULL, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), text_norm TEXT NOT NULL, text_compact TEXT NOT NULL, weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (song_id, field, text_compact));
       CREATE TABLE search_tokens (kind TEXT NOT NULL CHECK (kind IN ('term', 'prefix', 'gram2', 'gram3', 'initial')), token TEXT NOT NULL, song_id TEXT NOT NULL, field TEXT NOT NULL CHECK (field IN ('title_primary', 'title_ko', 'artist_primary', 'artist_ko', 'artist_alias')), weight INTEGER NOT NULL, provider_mask INTEGER NOT NULL, PRIMARY KEY (kind, token, song_id, field));
       CREATE TABLE search_token_stats (kind TEXT NOT NULL, token TEXT NOT NULL, df INTEGER NOT NULL, idf_scaled INTEGER NOT NULL, PRIMARY KEY (kind, token));`,
    );

    createSongDatabase(db);

    // The upgrade must add search_hints and relax the search_tokens CHECK so a
    // *_hint token can be written without a constraint failure.
    expect(() =>
      importSongs(db, [YORU_RECORD], {
        searchHints: [
          {
            songId: 'joysound-190001',
            field: 'title',
            text: 'よるにかける',
            source: 'joysound_songNameRuby',
            confidence: 'high',
          },
        ],
      }),
    ).not.toThrow();

    const hintTokenCount = db
      .prepare(`SELECT COUNT(*) AS count FROM search_tokens WHERE field = 'title_hint'`)
      .get() as unknown as { count: number };
    expect(hintTokenCount.count).toBeGreaterThan(0);
  });
});

describe('P2 hint sidecar parsing', () => {
  it('parses a generic flat hint row (snake_case)', () => {
    const path = tempFile(
      'flat.jsonl',
      `${JSON.stringify({
        song_id: 'joysound-190001',
        field: 'title',
        text: 'よるにかける',
        source: 'joysound_songNameRuby',
        confidence: 'high',
      })}\n`,
    );

    expect(parseSearchHintFile(path)).toEqual([
      {
        songId: 'joysound-190001',
        field: 'title',
        text: 'よるにかける',
        source: 'joysound_songNameRuby',
        confidence: 'high',
      },
    ]);
  });

  it('parses a generic flat hint row (camelCase) from a JSON array file', () => {
    const path = tempFile(
      'flat.json',
      `${JSON.stringify(
        [
          {
            songId: 'joysound-190001',
            field: 'artist',
            text: 'よあそび',
            source: 'manual',
          },
        ],
        null,
        2,
      )}\n`,
    );

    expect(parseSearchHintFile(path)).toEqual([
      {
        songId: 'joysound-190001',
        field: 'artist',
        text: 'よあそび',
        source: 'manual',
        confidence: undefined,
      },
    ]);
  });

  it('parses a grouped hint row with a hints array', () => {
    const path = tempFile(
      'grouped.jsonl',
      `${JSON.stringify({
        songId: 'joysound-190001',
        hints: [
          {
            field: 'title',
            text: 'よるにかける',
            source: 'joysound_songNameRuby',
            confidence: 'high',
          },
          { field: 'artist', text: 'よあそび', source: 'joysound_artistRuby' },
        ],
      })}\n`,
    );

    expect(parseSearchHintFile(path)).toEqual([
      {
        songId: 'joysound-190001',
        field: 'title',
        text: 'よるにかける',
        source: 'joysound_songNameRuby',
        confidence: 'high',
      },
      {
        songId: 'joysound-190001',
        field: 'artist',
        text: 'よあそび',
        source: 'joysound_artistRuby',
        confidence: undefined,
      },
    ]);
  });

  it('maps a JOYSOUND admit decision-log row to a title ruby hint', () => {
    const path = tempFile(
      'decision.jsonl',
      [
        JSON.stringify({
          naviGroupId: '190001',
          selSongNo: '190-001',
          decision: 'admit',
          detail: { naviGroupId: '190001', songNameRuby: 'よるにかける' },
        }),
        JSON.stringify({
          naviGroupId: '777777',
          selSongNo: '777-777',
          decision: 'drop',
          detail: { songNameRuby: 'ドロップタイトル' },
        }),
        JSON.stringify({
          naviGroupId: '888888',
          selSongNo: '888-888',
          decision: 'admit',
          detail: { songNameRuby: '' },
        }),
      ].join('\n'),
    );

    // Only the admit row with a non-empty ruby survives; the drop row and the
    // empty-ruby row are ignored.
    expect(parseSearchHintFile(path)).toEqual([
      {
        songId: 'joysound-190001',
        field: 'title',
        text: 'よるにかける',
        source: 'joysound_songNameRuby',
        confidence: 'high',
      },
    ]);
  });

  it('ignores malformed rows without throwing', () => {
    const path = tempFile(
      'malformed.jsonl',
      [
        JSON.stringify({ field: 'title', text: 'no song id', source: 'x' }),
        JSON.stringify({ song_id: 'x-1', field: 'lyrics', text: 'bad field', source: 'x' }),
        JSON.stringify({ song_id: 'x-1', field: 'title', text: '', source: 'x' }),
        'not json at all',
        JSON.stringify(42),
      ].join('\n'),
    );

    expect(parseSearchHintFile(path)).toEqual([]);
  });
});

describe('P3 derived kana→romaji hints', () => {
  it('derives a romaji hint from a kana ruby hint with its own provenance', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [YORU_RECORD], {
      searchHints: [
        {
          songId: 'joysound-190001',
          field: 'title',
          text: 'よるにかける',
          source: 'joysound_songNameRuby',
          confidence: 'high',
        },
      ],
    });

    const rows = db
      .prepare(
        `SELECT source, text_norm, confidence
        FROM search_hints
        WHERE song_id = 'joysound-190001' AND field = 'title'
        ORDER BY source ASC`,
      )
      .all() as unknown as Array<{ source: string; text_norm: string; confidence: string }>;
    expect(rows).toEqual([
      // Derived romaji inherits the parent hint's confidence.
      { source: 'derived_kana_romaji', text_norm: 'yorunikakeru', confidence: 'high' },
      { source: 'joysound_songNameRuby', text_norm: 'よるにかける', confidence: 'high' },
    ]);

    // The derived romaji must be tokenized so a romaji query can match it.
    const romajiTerm = db
      .prepare(
        `SELECT 1 FROM search_tokens
        WHERE song_id = 'joysound-190001' AND field = 'title_hint'
          AND kind = 'term' AND token = 'yorunikakeru'`,
      )
      .get();
    expect(romajiTerm).toBeDefined();
  });

  it('deduplicates normalized romaji equivalents across kana hints', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    // Hiragana + katakana spellings of the same reading romanize identically;
    // only one derived romaji row should result.
    importSongs(db, [YORU_RECORD], {
      searchHints: [
        {
          songId: 'joysound-190001',
          field: 'title',
          text: 'よるにかける',
          source: 'joysound_songNameRuby',
          confidence: 'high',
        },
        {
          songId: 'joysound-190001',
          field: 'title',
          text: 'ヨルニカケル',
          source: 'manual_kana',
          confidence: 'medium',
        },
      ],
    });

    const derived = db
      .prepare(
        `SELECT text_norm FROM search_hints
        WHERE song_id = 'joysound-190001' AND source = 'derived_kana_romaji'`,
      )
      .all() as unknown as Array<{ text_norm: string }>;
    expect(derived).toEqual([{ text_norm: 'yorunikakeru' }]);
  });

  it('does not derive romaji from a romaji or kanji hint', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [YORU_RECORD], {
      searchHints: [
        {
          songId: 'joysound-190001',
          field: 'artist',
          text: 'yoasobi',
          source: 'manual',
          confidence: 'high',
        },
      ],
    });

    const derived = db
      .prepare(`SELECT COUNT(*) AS count FROM search_hints WHERE source = 'derived_kana_romaji'`)
      .get() as unknown as { count: number };
    expect(derived.count).toBe(0);
  });
});

describe('P2 importSongsJson with hint sidecars', () => {
  it('indexes hints from a sidecar file and ignores unknown song ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-hints-build-'));
    const inputPath = join(dir, 'songs.json');
    const hintsPath = join(dir, 'hints.jsonl');
    const dbPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([YORU_RECORD], null, 2)}\n`, 'utf8');
    writeFileSync(
      hintsPath,
      [
        JSON.stringify({
          song_id: 'joysound-190001',
          field: 'title',
          text: 'よるにかける',
          source: 'joysound_songNameRuby',
          confidence: 'high',
        }),
        JSON.stringify({
          song_id: 'joysound-does-not-exist',
          field: 'title',
          text: 'ゴースト',
          source: 'joysound_songNameRuby',
          confidence: 'high',
        }),
      ].join('\n'),
      'utf8',
    );

    importSongsJson({ inputPath, dbPath, searchHintPaths: [hintsPath] });

    const db = openSongDatabase(dbPath);
    openDatabases.push(db);
    const rows = db.prepare('SELECT DISTINCT song_id FROM search_hints').all() as unknown as Array<{
      song_id: string;
    }>;
    // The unknown song id contributes nothing; only the known song is indexed.
    expect(rows).toEqual([{ song_id: 'joysound-190001' }]);

    const sources = db
      .prepare(
        `SELECT source, text_norm FROM search_hints
        WHERE song_id = 'joysound-190001' ORDER BY source ASC`,
      )
      .all() as unknown as Array<{ source: string; text_norm: string }>;
    // The kana ruby plus its derived romaji (P3).
    expect(sources).toEqual([
      { source: 'derived_kana_romaji', text_norm: 'yorunikakeru' },
      { source: 'joysound_songNameRuby', text_norm: 'よるにかける' },
    ]);
  });

  it('still builds normally when no sidecar is provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-hints-build-'));
    const inputPath = join(dir, 'songs.json');
    const dbPath = join(dir, 'songs.sqlite');
    writeFileSync(inputPath, `${JSON.stringify([YORU_RECORD], null, 2)}\n`, 'utf8');

    importSongsJson({ inputPath, dbPath });

    const db = openSongDatabase(dbPath);
    openDatabases.push(db);
    const count = db.prepare('SELECT COUNT(*) AS count FROM search_hints').get() as unknown as {
      count: number;
    };
    expect(count.count).toBe(0);
  });
});
