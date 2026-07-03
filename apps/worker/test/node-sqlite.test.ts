import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index.js';
import { SqliteSearchDatabase } from '../src/sqlite-adapter.js';

const openDatabases: SongDatabase[] = [];

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'node-1',
    source_url: 'https://example.com/node-1',
    title_primary: '残酷な天使のテーゼ',
    title_ko: '잔혹한 천사의 테제',
    artist_primary: '高橋洋子',
    artist_ko: null,
    karaoke_numbers: { tj: '068748', ky: null, joysound: '613446' },
    crawled_at: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe('SqliteSearchDatabase', () => {
  it('adapts node:sqlite databases to the Worker search handler', async () => {
    const sqlite = openSongDatabase(':memory:');
    openDatabases.push(sqlite);
    createSongDatabase(sqlite);
    importSongs(sqlite, FIXTURE_RECORDS);
    const db = new SqliteSearchDatabase(sqlite);

    const response = await handleRequest(
      new Request('https://api.example.test/api/search?q=68748'),
      {
        db,
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: FIXTURE_RECORDS, nextCursor: null });
  });

  it('can inspect bound SQL statements for query-plan smoke checks', async () => {
    const sqlite = openSongDatabase(':memory:');
    openDatabases.push(sqlite);
    createSongDatabase(sqlite);
    importSongs(sqlite, FIXTURE_RECORDS);
    const statements: string[] = [];
    const db = new SqliteSearchDatabase(sqlite, {
      inspectStatement: (sql) => statements.push(sql),
    });

    const response = await handleRequest(
      new Request('https://api.example.test/api/search?q=68748'),
      {
        db,
      },
    );

    expect(response.status).toBe(200);
    expect(statements.some((sql) => sql.includes('FROM karaoke_numbers kn'))).toBe(true);
  });
});
