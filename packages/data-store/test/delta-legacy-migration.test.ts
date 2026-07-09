import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import type { SearchHintInput } from '../src/hints.js';
import {
  applySongDeltaPatch,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '../src/index.js';
import type { SongDatabase } from '../src/schema.js';

const openDatabases: SongDatabase[] = [];

function openMemoryDb(): SongDatabase {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

function song(id: string, title: string, artist: string): SongRecord {
  return {
    id,
    source_url: 'https://example.com/x',
    title_primary: title,
    title_ko: null,
    artist_primary: artist,
    artist_ko: null,
    karaoke_numbers: { tj: id.replace(/[^0-9]/gu, '') || '1', ky: null, joysound: null },
    crawled_at: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Rewrite `search_texts` into its PRE-#93 (legacy) shape: the same rows plus a
 * NOT NULL `text_norm` column. A DB produced by pre-#93 serving code looks like
 * this; opening it with current code makes `createSongDatabase` DROP+recreate
 * the whole table to retire `text_norm`.
 */
function makeLegacySearchTexts(db: SongDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE search_texts RENAME TO search_texts_old');
  db.exec(
    `CREATE TABLE search_texts (
       song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
       field TEXT NOT NULL CHECK (field IN ('title_primary','title_ko','artist_primary','artist_ko','artist_alias')),
       text_norm TEXT NOT NULL,
       text_compact TEXT NOT NULL,
       weight INTEGER NOT NULL,
       provider_mask INTEGER NOT NULL,
       PRIMARY KEY (song_id, field, text_compact)
     ) WITHOUT ROWID`,
  );
  db.exec(
    `INSERT INTO search_texts (song_id, field, text_norm, text_compact, weight, provider_mask)
     SELECT song_id, field, text_compact, text_compact, weight, provider_mask FROM search_texts_old`,
  );
  db.exec('DROP TABLE search_texts_old');
  db.exec('PRAGMA foreign_keys = ON;');
}

/**
 * Rewrite `search_tokens` into a legacy field set that predates the R4 reading
 * fields and the search-hint channel (no `title_ruby`/`title_hint`). Opening it
 * with current code makes `createSongDatabase` DROP+recreate the whole table.
 */
function makeLegacySearchTokens(db: SongDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('ALTER TABLE search_tokens RENAME TO search_tokens_old');
  db.exec(
    `CREATE TABLE search_tokens (
       kind TEXT NOT NULL CHECK (kind IN ('term','prefix','gram1','gram2','gram3','initial')),
       token TEXT NOT NULL,
       song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
       field TEXT NOT NULL CHECK (field IN ('title_primary','title_ko','artist_primary','artist_ko','artist_alias')),
       weight INTEGER NOT NULL,
       provider_mask INTEGER NOT NULL,
       PRIMARY KEY (kind, token, song_id, field)
     ) WITHOUT ROWID`,
  );
  db.exec(
    `INSERT INTO search_tokens (kind, token, song_id, field, weight, provider_mask)
     SELECT kind, token, song_id, field, weight, provider_mask FROM search_tokens_old`,
  );
  db.exec('DROP TABLE search_tokens_old');
  db.exec('PRAGMA foreign_keys = ON;');
}

const DERIVED_TABLE_COLUMNS = {
  search_texts: 'song_id, field, text_compact, weight, provider_mask',
  search_tokens: 'kind, token, song_id, field, weight, provider_mask',
  search_token_stats: 'kind, token, df, idf_scaled',
} as const;

function dumpTable(db: SongDatabase, table: keyof typeof DERIVED_TABLE_COLUMNS): string[] {
  const cols = DERIVED_TABLE_COLUMNS[table];
  return (db.prepare(`SELECT ${cols} FROM ${table} ORDER BY ${cols}`).all() as unknown[]).map(
    (row) => JSON.stringify(row),
  );
}

function countRows(db: SongDatabase, table: string, songId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE song_id = ?`).get(songId) as { c: number }
  ).c;
}

function fullImport(
  records: readonly SongRecord[],
  hints: readonly SearchHintInput[],
): SongDatabase {
  const db = openMemoryDb();
  createSongDatabase(db);
  importSongs(db, records, { searchHints: hints });
  return db;
}

function expectDerivedStateEqualsFullImport(
  patched: SongDatabase,
  candidate: readonly SongRecord[],
  hints: readonly SearchHintInput[],
): void {
  const reference = fullImport(candidate, hints);
  for (const table of Object.keys(
    DERIVED_TABLE_COLUMNS,
  ) as (keyof typeof DERIVED_TABLE_COLUMNS)[]) {
    expect(dumpTable(patched, table), `table ${table} must match a full import`).toEqual(
      dumpTable(reference, table),
    );
  }
}

describe('delta patch across a destructive legacy-DB migration', () => {
  // C1 -> C2: change tj-1, keep tj-2/tj-3 UNTOUCHED. A curated hint targets the
  // UNTOUCHED tj-2 so the rebuild-all path is checked for hint materialization.
  const c1: SongRecord[] = [
    song('tj-1', 'alpha song', 'first artist'),
    song('tj-2', 'beta song', 'second artist'),
    song('tj-3', 'gamma song', 'third artist'),
  ];
  const c2: SongRecord[] = [
    song('tj-1', 'alpha song remastered', 'first artist'),
    song('tj-2', 'beta song', 'second artist'),
    song('tj-3', 'gamma song', 'third artist'),
  ];
  // A curated hint on the UNTOUCHED tj-2: only the rebuild-all path can
  // materialize it (the touched-only path never revisits tj-2).
  const hints: SearchHintInput[] = [
    {
      songId: 'tj-2',
      field: 'artist',
      text: 'curated alias',
      source: 'manual',
      confidence: 'high',
    },
  ];
  // A curated hint on the TOUCHED tj-1: both the touched-only delta path and a
  // full import materialize it, so the current-schema path stays at parity.
  // (Hints targeting UNTOUCHED songs are a separate, deferred finding and are
  // intentionally not asserted on the current-schema path.)
  const touchedHints: SearchHintInput[] = [
    {
      songId: 'tj-1',
      field: 'artist',
      text: 'curated alias',
      source: 'manual',
      confidence: 'high',
    },
  ];

  it('reports a dropped derived table only when a legacy migration fires', () => {
    const fresh = openMemoryDb();
    expect(createSongDatabase(fresh).droppedDerivedTable).toBe(false);
    // Re-running on a current-schema DB is idempotent: no drop.
    expect(createSongDatabase(fresh).droppedDerivedTable).toBe(false);

    const legacyTexts = openMemoryDb();
    createSongDatabase(legacyTexts);
    importSongs(legacyTexts, c1);
    makeLegacySearchTexts(legacyTexts);
    expect(createSongDatabase(legacyTexts).droppedDerivedTable).toBe(true);

    const legacyTokens = openMemoryDb();
    createSongDatabase(legacyTokens);
    importSongs(legacyTokens, c1);
    makeLegacySearchTokens(legacyTokens);
    expect(createSongDatabase(legacyTokens).droppedDerivedTable).toBe(true);
  });

  it('re-derives ALL songs when the legacy search_texts migration drops the table', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, c1);
    makeLegacySearchTexts(db);

    applySongDeltaPatch({
      db,
      baseRecords: c1,
      candidateRecords: c2,
      searchHints: hints,
      checkDbMatchesBase: false,
      maxTouchedSongs: 100,
      maxTouchedRatio: 1,
    });

    // The untouched song keeps its exact-text tier and hint recall.
    expect(countRows(db, 'search_texts', 'tj-2')).toBeGreaterThan(0);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS c FROM search_tokens WHERE song_id = 'tj-2' AND field = 'artist_hint'",
          )
          .get() as { c: number }
      ).c,
    ).toBeGreaterThan(0);
    expectDerivedStateEqualsFullImport(db, c2, hints);
  });

  it('re-derives ALL songs when the legacy search_tokens migration drops the table', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, c1);
    makeLegacySearchTokens(db);

    applySongDeltaPatch({
      db,
      baseRecords: c1,
      candidateRecords: c2,
      searchHints: hints,
      checkDbMatchesBase: false,
      maxTouchedSongs: 100,
      maxTouchedRatio: 1,
    });

    expect(countRows(db, 'search_texts', 'tj-2')).toBeGreaterThan(0);
    expectDerivedStateEqualsFullImport(db, c2, hints);
  });

  it('leaves the current-schema delta path unchanged (no rebuild, full-import parity)', () => {
    const db = openMemoryDb();
    createSongDatabase(db);
    importSongs(db, c1);

    applySongDeltaPatch({
      db,
      baseRecords: c1,
      candidateRecords: c2,
      searchHints: touchedHints,
      checkDbMatchesBase: false,
      maxTouchedSongs: 100,
      maxTouchedRatio: 1,
    });

    expectDerivedStateEqualsFullImport(db, c2, touchedHints);
  });
});
