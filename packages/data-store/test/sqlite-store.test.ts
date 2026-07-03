import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { runDataStoreCli } from '../src/cli.js';
import {
  SONG_SCHEMA_SQL,
  applySongDeltaPatch,
  createSongDatabase,
  exportSongs,
  exportSongsJson,
  importSongs,
  importSongsJson,
  openSongDatabase,
} from '../src/index.js';
import type { SongDatabase } from '../src/schema.js';
import {
  GRAM1_DF_CAP,
  SONG_ID_IN_CHUNK_SIZE,
  collectTokenKeysForSongs,
  deleteSearchTokensForSongs,
  pruneHighDfGram1Tokens,
} from '../src/search-index.js';

const openDatabases: Array<{ close(): void }> = [];

function openMemoryDb() {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'blog-1',
    source_url: 'https://example.com/blog/1',
    title_primary: 'Yoru ni Kakeru',
    title_ko: 'Night Running',
    artist_primary: 'YOASOBI',
    artist_ko: null,
    artist_aliases: ['Yoasobi Alias', 'Yoasobi Alt'],
    karaoke_numbers: { tj: '68000', ky: null, joysound: '123456' },
    crawled_at: '2026-01-01T00:00:00.000Z',
    title_ko_source: 'manual',
  },
  {
    id: 'tj-2',
    source_url: 'https://example.com/tj/2',
    title_primary: 'Reincarnation Apple',
    title_ko: null,
    artist_primary: 'PinocchioP',
    artist_ko: null,
    karaoke_numbers: { tj: '68222', ky: '44999', joysound: null },
    crawled_at: '2026-01-02T00:00:00.000Z',
    media_context_ko: '(Vocaloid)',
  },
];

const CJK_SEARCH_RECORD: SongRecord = {
  id: 'joysound-613446',
  source_url: 'https://example.com/joysound/613446',
  title_primary: '残酷な天使のテーゼ',
  title_ko: '사랑했나봐',
  artist_primary: "B'z",
  artist_ko: '비즈',
  artist_aliases: ['Mrs. GREEN APPLE'],
  karaoke_numbers: { tj: '068748', ky: null, joysound: '613446' },
  crawled_at: '2026-01-03T00:00:00.000Z',
};

function cloneRecords(records: readonly SongRecord[]): SongRecord[] {
  return structuredClone(records) as SongRecord[];
}

function fixtureRecord(index: number): SongRecord {
  const record = FIXTURE_RECORDS[index];
  if (record === undefined) {
    throw new Error(`Missing fixture record at index ${index}`);
  }
  return record;
}

describe('SQLite song store', () => {
  it('round-trips SongRecord objects without changing order or optional fields', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, FIXTURE_RECORDS);

    const exported = exportSongs(db);
    expect(exported).toEqual(FIXTURE_RECORDS);
    expect(JSON.stringify(exported)).toBe(JSON.stringify(FIXTURE_RECORDS));
  });

  it('preserves an explicit empty artist_aliases array', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    const records = cloneRecords(FIXTURE_RECORDS);
    records[0] = { ...fixtureRecord(0), artist_aliases: [] };

    importSongs(db, records);

    const exported = exportSongs(db);
    expect(exported).toEqual(records);
    expect(JSON.stringify(exported)).toBe(JSON.stringify(records));
  });

  it('is idempotent when importing the same source corpus twice', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, FIXTURE_RECORDS);
    importSongs(db, FIXTURE_RECORDS);

    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('treats importSongs as a complete corpus replacement', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    const secondRecord = fixtureRecord(1);

    importSongs(db, FIXTURE_RECORDS);
    importSongs(db, [secondRecord]);

    expect(exportSongs(db)).toEqual([secondRecord]);
  });

  it('rejects duplicate song ids before changing the database', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, FIXTURE_RECORDS);
    const firstRecord = fixtureRecord(0);
    const duplicate = {
      ...fixtureRecord(1),
      id: firstRecord.id,
      title_primary: 'Duplicate Should Not Win',
    };

    expect(() => importSongs(db, [firstRecord, duplicate])).toThrow(/Duplicate song id: blog-1/);
    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('imports and exports a JSON corpus file through a SQLite database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const inputPath = join(dir, 'songs.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const json = `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`;
    writeFileSync(inputPath, json, 'utf8');

    importSongsJson({ inputPath, dbPath });
    exportSongsJson({ dbPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toBe(json);
  });

  it('does not replace an existing SQLite database when JSON import fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const validPath = join(dir, 'valid.json');
    const invalidPath = join(dir, 'invalid.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const validJson = `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`;
    writeFileSync(validPath, validJson, 'utf8');
    writeFileSync(invalidPath, '{not-valid-json', 'utf8');
    importSongsJson({ inputPath: validPath, dbPath });

    expect(() => importSongsJson({ inputPath: invalidPath, dbPath })).toThrow();
    exportSongsJson({ dbPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toBe(validJson);
  });

  it('exposes schema SQL that creates a store-compatible database', () => {
    const db = openMemoryDb();

    db.exec(SONG_SCHEMA_SQL);
    importSongs(db, FIXTURE_RECORDS);

    expect(exportSongs(db)).toEqual(FIXTURE_RECORDS);
  });

  it('creates derived search index tables and lookup indexes', () => {
    const db = openMemoryDb();

    db.exec(SONG_SCHEMA_SQL);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN ('search_texts', 'search_tokens', 'search_token_stats')
        ORDER BY name ASC`,
      )
      .all() as unknown as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'search_texts',
      'search_token_stats',
      'search_tokens',
    ]);

    const searchTextColumns = db
      .prepare('PRAGMA table_info(search_texts)')
      .all() as unknown as Array<{
      name: string;
    }>;
    expect(searchTextColumns.map((column) => column.name)).toEqual([
      'song_id',
      'field',
      'text_norm',
      'text_compact',
      'weight',
      'provider_mask',
    ]);

    const numberColumns = db
      .prepare('PRAGMA table_info(karaoke_numbers)')
      .all() as unknown as Array<{
      name: string;
    }>;
    expect(numberColumns.map((column) => column.name)).toEqual([
      'song_id',
      'provider',
      'number',
      'number_key',
    ]);

    const numberIndexes = db
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE 'idx_karaoke_numbers_%'
        ORDER BY name ASC`,
      )
      .all() as unknown as Array<{ name: string }>;
    expect(numberIndexes.map((row) => row.name)).toEqual([
      'idx_karaoke_numbers_number',
      'idx_karaoke_numbers_number_key',
      'idx_karaoke_numbers_provider_number',
    ]);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE 'idx_search_%'
        ORDER BY name ASC`,
      )
      .all() as unknown as Array<{ name: string }>;
    // idx_search_texts_song(song_id) and idx_search_tokens_lookup(kind, token,
    // song_id) were dropped: each was a left-prefix of its table's primary key,
    // so the PK already serves those lookups. idx_search_tokens_song(song_id)
    // was also dropped (2026-07, I4): it was ~41% of the DB and served only the
    // delta patcher's per-song token sweeps, which are now set-based over all
    // touched songs (collectTokenKeysForSongs / deleteSearchTokensForSongs) and
    // need no song_id index. So idx_search_texts_compact is the only survivor.
    expect(indexes.map((row) => row.name)).toEqual(['idx_search_texts_compact']);
  });

  it('materializes exact text, token, and token-stat search index rows during SQLite import', () => {
    const db = openMemoryDb();
    createSongDatabase(db);

    importSongs(db, [CJK_SEARCH_RECORD]);

    const numberKey = db
      .prepare(
        `SELECT number_key FROM karaoke_numbers
        WHERE song_id = ? AND provider = 'tj'`,
      )
      .get(CJK_SEARCH_RECORD.id) as unknown as { number_key: string };
    expect(numberKey.number_key).toBe('68748');

    const exactTexts = db
      .prepare(
        `SELECT field, text_compact, weight, provider_mask
        FROM search_texts
        WHERE song_id = ?
        ORDER BY field ASC, text_compact ASC`,
      )
      .all(CJK_SEARCH_RECORD.id) as unknown as Array<{
      field: string;
      text_compact: string;
      weight: number;
      provider_mask: number;
    }>;
    expect(exactTexts).toEqual(
      expect.arrayContaining([
        {
          field: 'title_primary',
          text_compact: '残酷な天使のテーゼ',
          weight: 5,
          provider_mask: 5,
        },
        {
          field: 'artist_alias',
          text_compact: 'mrsgreenapple',
          weight: 2,
          provider_mask: 5,
        },
      ]),
    );

    const tokens = db
      .prepare(
        `SELECT kind, token, field
        FROM search_tokens
        WHERE song_id = ?
        ORDER BY kind ASC, token ASC, field ASC`,
      )
      .all(CJK_SEARCH_RECORD.id) as unknown as Array<{
      kind: string;
      token: string;
      field: string;
    }>;
    expect(tokens).toEqual(
      expect.arrayContaining([
        { kind: 'gram2', token: '天使', field: 'title_primary' },
        { kind: 'gram3', token: '天使の', field: 'title_primary' },
        { kind: 'gram1', token: '天', field: 'title_primary' },
        { kind: 'initial', token: 'ㅅㄹㅎㄴㅂ', field: 'title_ko' },
        { kind: 'prefix', token: 'mr', field: 'artist_alias' },
      ]),
    );

    const tokenStats = db
      .prepare(
        `SELECT df, idf_scaled FROM search_token_stats WHERE kind = 'gram2' AND token = '天使'`,
      )
      .get() as unknown as { df: number; idf_scaled: number };
    expect(tokenStats.df).toBe(1);
    expect(tokenStats.idf_scaled).toBeGreaterThan(0);
  });

  it('round-trips a JSON corpus through the data-store CLI runner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-'));
    const inputPath = join(dir, 'songs.json');
    const dbPath = join(dir, 'songs-cli.sqlite');
    const outputPath = join(dir, 'roundtrip-cli.json');
    const json = `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`;
    writeFileSync(inputPath, json, 'utf8');

    runDataStoreCli(['import-json', '--input', inputPath, '--db', dbPath]);
    runDataStoreCli(['export-json', '--db', dbPath, '--output', outputPath]);

    expect(readFileSync(outputPath, 'utf8')).toBe(json);
  });

  it('patches a small JSON delta without rebuilding unaffected search rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-delta-'));
    const basePath = join(dir, 'base.json');
    const candidatePath = join(dir, 'candidate.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const manifestPath = join(dir, 'patch-manifest.json');
    const baseRecords: SongRecord[] = [
      {
        id: 'joysound-100',
        source_url: 'https://example.com/joysound/100',
        title_primary: 'Merge Target',
        title_ko: null,
        artist_primary: 'Patch Artist',
        artist_ko: null,
        karaoke_numbers: { tj: null, ky: '50000', joysound: '100' },
        crawled_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'tj-90000',
        source_url: 'https://example.com/tj/90000',
        title_primary: 'Merge Target(TV OP)',
        title_ko: null,
        artist_primary: 'Patch Artist',
        artist_ko: null,
        karaoke_numbers: { tj: '90000', ky: null, joysound: null },
        crawled_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'joysound-200',
        source_url: 'https://example.com/joysound/200',
        title_primary: 'Stable Song',
        title_ko: null,
        artist_primary: 'Stable Artist',
        artist_ko: null,
        karaoke_numbers: { tj: null, ky: null, joysound: '200' },
        crawled_at: '2026-01-03T00:00:00.000Z',
      },
    ];
    const candidateRecords: SongRecord[] = [
      {
        ...baseRecords[0],
        karaoke_numbers: { tj: '90000', ky: '50000', joysound: '100' },
      },
      baseRecords[2],
      {
        id: 'tj-90001',
        source_url: 'https://example.com/tj/90001',
        title_primary: 'Fresh Delta Song',
        title_ko: null,
        artist_primary: 'Fresh Artist',
        artist_ko: null,
        karaoke_numbers: { tj: '90001', ky: null, joysound: null },
        crawled_at: '2026-01-04T00:00:00.000Z',
      },
    ];
    writeFileSync(basePath, `${JSON.stringify(baseRecords, null, 2)}\n`, 'utf8');
    writeFileSync(candidatePath, `${JSON.stringify(candidateRecords, null, 2)}\n`, 'utf8');
    importSongsJson({ inputPath: basePath, dbPath });

    runDataStoreCli([
      'patch-json-delta',
      '--base',
      basePath,
      '--candidate',
      candidatePath,
      '--db',
      dbPath,
      '--manifest',
      manifestPath,
      '--max-touched-songs',
      '10',
      '--max-touched-ratio',
      '1',
    ]);
    exportSongsJson({ dbPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toBe(`${JSON.stringify(candidateRecords, null, 2)}\n`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      addedCount: number;
      removedCount: number;
      changedCount: number;
      sortOrderChangedCount: number;
      sqlite: { mutated: boolean; baseDbMatch: string };
      tokenStats: { affectedTokenCount: number; recalculatedTokenStatCount: number };
    };
    expect(manifest.addedCount).toBe(1);
    expect(manifest.removedCount).toBe(1);
    expect(manifest.changedCount).toBe(1);
    expect(manifest.sortOrderChangedCount).toBe(2);
    expect(manifest.sqlite).toEqual({ mutated: true, baseDbMatch: 'checked' });
    expect(manifest.tokenStats.affectedTokenCount).toBeGreaterThan(0);
    expect(manifest.tokenStats.recalculatedTokenStatCount).toBe(
      manifest.tokenStats.affectedTokenCount,
    );

    const db = openSongDatabase(dbPath);
    openDatabases.push(db);
    const removed = db
      .prepare("SELECT COUNT(*) AS count FROM songs WHERE id = 'tj-90000'")
      .get() as {
      count: number;
    };
    expect(removed.count).toBe(0);
    const mergedNumbers = db
      .prepare(
        `SELECT provider, number, number_key FROM karaoke_numbers
         WHERE song_id = 'joysound-100'
         ORDER BY provider ASC`,
      )
      .all() as unknown as Array<{
      provider: string;
      number: string | null;
      number_key: string | null;
    }>;
    expect(mergedNumbers).toEqual([
      { provider: 'joysound', number: '100', number_key: '100' },
      { provider: 'ky', number: '50000', number_key: '50000' },
      { provider: 'tj', number: '90000', number_key: '90000' },
    ]);
    const providerMasks = db
      .prepare(
        `SELECT DISTINCT provider_mask FROM search_tokens
         WHERE song_id = 'joysound-100'
         ORDER BY provider_mask ASC`,
      )
      .all() as unknown as Array<{ provider_mask: number }>;
    expect(providerMasks).toEqual([{ provider_mask: 7 }]);
  });

  it('writes a dry-run manifest without mutating the SQLite DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-delta-'));
    const basePath = join(dir, 'base.json');
    const candidatePath = join(dir, 'candidate.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const manifestPath = join(dir, 'patch-manifest.json');
    const candidateRecords = cloneRecords(FIXTURE_RECORDS);
    candidateRecords[0] = {
      ...fixtureRecord(0),
      karaoke_numbers: { ...fixtureRecord(0).karaoke_numbers, ky: '77777' },
    };
    writeFileSync(basePath, `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`, 'utf8');
    writeFileSync(candidatePath, `${JSON.stringify(candidateRecords, null, 2)}\n`, 'utf8');
    importSongsJson({ inputPath: basePath, dbPath });

    runDataStoreCli([
      'patch-json-delta',
      '--base',
      basePath,
      '--candidate',
      candidatePath,
      '--db',
      dbPath,
      '--manifest',
      manifestPath,
      '--dry-run',
      '--max-touched-ratio',
      '1',
    ]);
    exportSongsJson({ dbPath, outputPath });

    expect(readFileSync(outputPath, 'utf8')).toBe(`${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dryRun: boolean;
      changedCount: number;
      sqlite: { mutated: boolean };
    };
    expect(manifest.dryRun).toBe(true);
    expect(manifest.changedCount).toBe(1);
    expect(manifest.sqlite.mutated).toBe(false);
  });

  it('refuses to patch when the SQLite DB no longer matches the supplied base corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karaoke-data-store-delta-'));
    const actualPath = join(dir, 'actual.json');
    const basePath = join(dir, 'base.json');
    const candidatePath = join(dir, 'candidate.json');
    const dbPath = join(dir, 'songs.sqlite');
    const outputPath = join(dir, 'roundtrip.json');
    const staleBase = cloneRecords(FIXTURE_RECORDS);
    staleBase[0] = { ...fixtureRecord(0), title_primary: 'Stale Base Title' };
    const candidateRecords = cloneRecords(staleBase);
    candidateRecords[1] = {
      ...fixtureRecord(1),
      karaoke_numbers: { ...fixtureRecord(1).karaoke_numbers, joysound: '999999' },
    };
    writeFileSync(actualPath, `${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`, 'utf8');
    writeFileSync(basePath, `${JSON.stringify(staleBase, null, 2)}\n`, 'utf8');
    writeFileSync(candidatePath, `${JSON.stringify(candidateRecords, null, 2)}\n`, 'utf8');
    importSongsJson({ inputPath: actualPath, dbPath });

    expect(() =>
      runDataStoreCli([
        'patch-json-delta',
        '--base',
        basePath,
        '--candidate',
        candidatePath,
        '--db',
        dbPath,
        '--max-touched-ratio',
        '1',
      ]),
    ).toThrow(/does not match base corpus/);
    exportSongsJson({ dbPath, outputPath });
    expect(readFileSync(outputPath, 'utf8')).toBe(`${JSON.stringify(FIXTURE_RECORDS, null, 2)}\n`);
  });
});

/**
 * Build `count` schema-valid songs whose only non-ASCII character is `char`
 * (title `${char}${index}`; ASCII artist), so each song contributes exactly one
 * gram1 posting for `char` and the token's document frequency equals `count`.
 * Distinct ids and tj numbers keep every record unique.
 */
function gram1Corpus(char: string, count: number, prefix: string, tjBase: number): SongRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    source_url: `https://example.com/${prefix}/${index}`,
    title_primary: `${char}${index}`,
    title_ko: null,
    artist_primary: `Artist ${prefix} ${index}`,
    artist_ko: null,
    karaoke_numbers: { tj: String(tjBase + index), ky: null, joysound: null },
    crawled_at: '2026-01-01T00:00:00.000Z',
  }));
}

/**
 * Deterministically ordered logical dump of every corpus/derived table. Two
 * imports of the same records must produce byte-identical dumps.
 */
function dumpSearchDatabase(db: SongDatabase): string {
  const queries = [
    'SELECT * FROM songs ORDER BY sort_order, id',
    'SELECT * FROM karaoke_numbers ORDER BY song_id, provider',
    'SELECT * FROM artist_aliases ORDER BY song_id, position',
    'SELECT * FROM search_texts ORDER BY song_id, field, text_compact',
    'SELECT * FROM search_tokens ORDER BY kind, token, song_id, field',
    'SELECT * FROM search_token_stats ORDER BY kind, token',
    'SELECT * FROM search_hints ORDER BY song_id, field, source, text_compact',
    'SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx',
  ];
  return queries.map((sql) => JSON.stringify(db.prepare(sql).all())).join('\n');
}

function gram1Df(db: SongDatabase, token: string): number | undefined {
  const row = db
    .prepare("SELECT df FROM search_token_stats WHERE kind = 'gram1' AND token = ?")
    .get(token) as { df: number } | undefined;
  return row?.df;
}

function gram1PostingCount(db: SongDatabase, token: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM search_tokens WHERE kind = 'gram1' AND token = ?")
    .get(token) as { count: number };
  return row.count;
}

describe('gram1 df-cap pruning (T5-B)', () => {
  it('on import, prunes gram1 tokens above the cap and keeps tokens at the cap (boundary df=cap/cap+1)', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    // 'あ' in exactly GRAM1_DF_CAP songs -> df == cap -> KEPT (not > cap).
    // 'か' in GRAM1_DF_CAP + 1 songs      -> df == cap + 1 -> PRUNED.
    const kept = gram1Corpus('あ', GRAM1_DF_CAP, 'keep', 100_000);
    const pruned = gram1Corpus('か', GRAM1_DF_CAP + 1, 'prune', 300_000);

    importSongs(db, [...kept, ...pruned]);

    expect(gram1Df(db, 'あ')).toBe(GRAM1_DF_CAP);
    expect(gram1PostingCount(db, 'あ')).toBe(GRAM1_DF_CAP);
    // Pruned token is absent from BOTH postings and stats (the lock-step invariant).
    expect(gram1Df(db, 'か')).toBeUndefined();
    expect(gram1PostingCount(db, 'か')).toBe(0);
  });

  it('on a delta patch, prunes a gram1 token the candidate pushes above the cap and keeps a fresh below-cap token (affected mode)', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    // Base holds 'あ' exactly AT the cap, so the full import keeps it.
    const base = gram1Corpus('あ', GRAM1_DF_CAP, 'base', 100_000);
    importSongs(db, base);
    expect(gram1Df(db, 'あ')).toBe(GRAM1_DF_CAP);

    // Candidate appends one song containing 'あ' (df -> cap + 1) and a brand-new
    // below-cap char 'ぞ' (df == 1).
    const added: SongRecord = {
      id: 'delta-900',
      source_url: 'https://example.com/delta/900',
      title_primary: 'あぞ',
      title_ko: null,
      artist_primary: 'Delta Artist',
      artist_ko: null,
      karaoke_numbers: { tj: '900000', ky: null, joysound: null },
      crawled_at: '2026-02-01T00:00:00.000Z',
    };
    const candidate = [...base, added];

    const manifest = applySongDeltaPatch({
      db,
      baseRecords: base,
      candidateRecords: candidate,
      maxTouchedRatio: 1,
      tokenStatMode: 'affected',
    });

    // 'あ' crossed the cap via the delta -> pruned everywhere.
    expect(manifest.tokenStats.prunedGram1TokenCount).toBe(1);
    expect(gram1Df(db, 'あ')).toBeUndefined();
    expect(gram1PostingCount(db, 'あ')).toBe(0);
    // The freshly-touched below-cap char stays indexed.
    expect(gram1Df(db, 'ぞ')).toBe(1);
    expect(gram1PostingCount(db, 'ぞ')).toBe(1);
  });

  it('pruneHighDfGram1Tokens honors an injected cap and never touches other token kinds', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    // Import a small corpus (nothing hits GRAM1_DF_CAP), then re-run the prune
    // with a tiny explicit cap to exercise the boundary cheaply. '天' has df 3.
    importSongs(db, gram1Corpus('天', 3, 'x', 100_000));
    const gram2Before = db
      .prepare("SELECT COUNT(*) AS count FROM search_tokens WHERE kind = 'gram2'")
      .get() as { count: number };

    // cap = 3: df == 3 is NOT > cap, so nothing is pruned.
    expect(pruneHighDfGram1Tokens(db, 3)).toBe(0);
    expect(gram1PostingCount(db, '天')).toBe(3);
    // cap = 2: df == 3 > cap, so '天' is pruned.
    expect(pruneHighDfGram1Tokens(db, 2)).toBe(1);
    expect(gram1Df(db, '天')).toBeUndefined();
    expect(gram1PostingCount(db, '天')).toBe(0);
    // Other token kinds are untouched by a gram1 prune.
    const gram2After = db
      .prepare("SELECT COUNT(*) AS count FROM search_tokens WHERE kind = 'gram2'")
      .get() as { count: number };
    expect(gram2After.count).toBe(gram2Before.count);
  });

  it('produces an identical logical dump for the same corpus, including the gram1 prune (determinism)', () => {
    // Include an over-cap character so the prune step actually fires in both builds.
    const corpus = [...gram1Corpus('か', GRAM1_DF_CAP + 1, 'prune', 300_000), ...FIXTURE_RECORDS];

    const first = openMemoryDb();
    createSongDatabase(first);
    importSongs(first, corpus);
    const second = openMemoryDb();
    createSongDatabase(second);
    importSongs(second, corpus);

    expect(dumpSearchDatabase(first)).toBe(dumpSearchDatabase(second));
    // Not a vacuous check: the over-cap char really was pruned in the dumped DB.
    expect(gram1PostingCount(first, 'か')).toBe(0);
  });
});

describe('set-based token sweeps (T5-C — idx_search_tokens_song removed)', () => {
  const CJK_SEARCH_RECORD_2: SongRecord = {
    id: 'joysound-777',
    source_url: 'https://example.com/joysound/777',
    title_primary: '夜に駆ける',
    title_ko: '밤을 달리다',
    artist_primary: 'YOASOBI',
    artist_ko: '요아소비',
    artist_aliases: ['よあそび'],
    karaoke_numbers: { tj: '777001', ky: null, joysound: '777' },
    crawled_at: '2026-01-05T00:00:00.000Z',
  };

  /** Union of the per-song `DISTINCT kind, token` sweeps the batch collect replaced. */
  function collectTokenKeysPerSong(db: SongDatabase, songIds: readonly string[]): Set<string> {
    const query = db.prepare('SELECT DISTINCT kind, token FROM search_tokens WHERE song_id = ?');
    const out = new Set<string>();
    for (const songId of songIds) {
      const rows = query.all(songId) as unknown as Array<{ kind: string; token: string }>;
      for (const row of rows) {
        out.add(`${row.kind} ${row.token}`);
      }
    }
    return out;
  }

  it('collectTokenKeysForSongs equals the union of the per-song sweeps it replaced', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, [CJK_SEARCH_RECORD, CJK_SEARCH_RECORD_2]);
    const songIds = [CJK_SEARCH_RECORD.id, CJK_SEARCH_RECORD_2.id];

    const batch = new Set<string>();
    collectTokenKeysForSongs(db, songIds, batch);

    expect(batch).toEqual(collectTokenKeysPerSong(db, songIds));
    // Guard against a vacuous comparison of two empty sets.
    expect(batch.size).toBeGreaterThan(0);
  });

  it('collectTokenKeysForSongs and deleteSearchTokensForSongs span the IN chunk boundary', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, [CJK_SEARCH_RECORD, CJK_SEARCH_RECORD_2]);

    // Place the two real ids in DIFFERENT chunks: id 1 at index 0 (chunk 1), id
    // 2 at index SONG_ID_IN_CHUNK_SIZE (chunk 2). The rest are non-existent ids
    // that pad the array past one chunk without needing thousands of real songs
    // (the IN list does not require its values to exist).
    const padded: string[] = Array.from(
      { length: SONG_ID_IN_CHUNK_SIZE + 1 },
      (_, index) => `absent-${index}`,
    );
    padded[0] = CJK_SEARCH_RECORD.id;
    padded[SONG_ID_IN_CHUNK_SIZE] = CJK_SEARCH_RECORD_2.id;

    const collected = new Set<string>();
    collectTokenKeysForSongs(db, padded, collected);
    // Chunked collect over both chunks equals the union of both songs' sweeps.
    expect(collected).toEqual(
      collectTokenKeysPerSong(db, [CJK_SEARCH_RECORD.id, CJK_SEARCH_RECORD_2.id]),
    );

    // The chunked delete clears both songs' postings across the boundary.
    deleteSearchTokensForSongs(db, padded);
    const remaining = db
      .prepare('SELECT COUNT(*) AS count FROM search_tokens WHERE song_id IN (?, ?)')
      .get(CJK_SEARCH_RECORD.id, CJK_SEARCH_RECORD_2.id) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it('drops a legacy idx_search_tokens_song and still applies a delta correctly', () => {
    const db = openMemoryDb();
    // Simulate a legacy database: canonical schema PLUS the removed index.
    createSongDatabase(db);
    db.exec('CREATE INDEX idx_search_tokens_song ON search_tokens(song_id)');
    const baseRecords = cloneRecords(FIXTURE_RECORDS);
    importSongs(db, baseRecords);
    // Legacy index is present before the patch runs.
    expect(hasSongIndex(db)).toBe(true);

    const candidateRecords = cloneRecords(FIXTURE_RECORDS);
    candidateRecords[0] = {
      ...fixtureRecord(0),
      title_primary: 'Yoru ni Kakeru (Delta Edit)',
    };
    const added: SongRecord = {
      id: 'joysound-888',
      source_url: 'https://example.com/joysound/888',
      title_primary: 'Legacy Delta Add',
      title_ko: null,
      artist_primary: 'Legacy Artist',
      artist_ko: null,
      karaoke_numbers: { tj: '888000', ky: null, joysound: null },
      crawled_at: '2026-01-06T00:00:00.000Z',
    };
    candidateRecords.push(added);

    const manifest = applySongDeltaPatch({
      db,
      baseRecords,
      candidateRecords,
      maxTouchedRatio: 1,
      tokenStatMode: 'affected',
    });

    // createSongDatabase (invoked inside the patch) reconverges the legacy DB on
    // the canonical schema, so the stale index is gone.
    expect(hasSongIndex(db)).toBe(false);
    expect(manifest.sqlite.mutated).toBe(true);
    // The delta still applied correctly on the (formerly legacy) database.
    expect(exportSongs(db)).toEqual(candidateRecords);
  });
});

function hasSongIndex(db: SongDatabase): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_schema
       WHERE type = 'index' AND name = 'idx_search_tokens_song'`,
    )
    .get() as { count: number };
  return row.count > 0;
}
