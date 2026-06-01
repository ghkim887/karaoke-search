import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type D1DatabaseLike, handleRequest } from '../src/index.js';

const openDatabases: SongDatabase[] = [];

function createD1WithSongs(records: readonly SongRecord[]): D1DatabaseLike {
  const sqlite = openSongDatabase(':memory:');
  openDatabases.push(sqlite);
  createSongDatabase(sqlite);
  importSongs(sqlite, records);
  return new NodeSqliteD1(sqlite);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'song-1',
    source_url: 'https://example.com/1',
    title_primary: 'Idol',
    title_ko: 'Idol Korean',
    artist_primary: 'YOASOBI',
    artist_ko: null,
    artist_aliases: ['Yoa Alias'],
    karaoke_numbers: { tj: '12345', ky: null, joysound: '999001' },
    categories: ['jpop'],
    crawled_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'song-2',
    source_url: 'https://example.com/2',
    title_primary: 'Kick Back',
    title_ko: null,
    artist_primary: 'Kenshi Yonezu',
    artist_ko: null,
    karaoke_numbers: { tj: '67890', ky: null, joysound: null },
    categories: ['anime'],
    crawled_at: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'song-3',
    source_url: 'https://example.com/3',
    title_primary: 'Senbonzakura',
    title_ko: null,
    artist_primary: 'Kurousa P',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: '11111', joysound: null },
    categories: ['vocaloid'],
    crawled_at: '2026-01-03T00:00:00.000Z',
  },
];

describe('worker search API', () => {
  it('returns matching songs from title, artist, alias, and karaoke number fields', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const byArtist = await fetchJson(db, '/api/search?q=yoasobi');
    const byAlias = await fetchJson(db, '/api/search?q=Yoa%20Alias');
    const byNumber = await fetchJson(db, '/api/search?q=67890');

    expect(byArtist.items.map((song) => song.id)).toEqual(['song-1']);
    expect(byAlias.items.map((song) => song.id)).toEqual(['song-1']);
    expect(byNumber.items.map((song) => song.id)).toEqual(['song-2']);
    expect(byArtist.items[0]).toEqual(FIXTURE_RECORDS[0]);
  });

  it('applies category and vendor filters', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const animeWithTj = await fetchJson(db, '/api/search?category=anime&vendor=tj');
    const animeWithKy = await fetchJson(db, '/api/search?category=anime&vendor=ky');

    expect(animeWithTj.items.map((song) => song.id)).toEqual(['song-2']);
    expect(animeWithKy.items).toEqual([]);
  });

  it('paginates using limit and cursor without dropping result order', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const first = await fetchJson(db, '/api/search?limit=2');
    const second = await fetchJson(db, `/api/search?limit=2&cursor=${first.nextCursor}`);

    expect(first.items.map((song) => song.id)).toEqual(['song-1', 'song-2']);
    expect(first.nextCursor).toBe('2');
    expect(second.items.map((song) => song.id)).toEqual(['song-3']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects invalid filters with HTTP 400', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const response = await handleRequest(
      new Request('https://karaoke.example/api/search?category=invalid'),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid category: invalid' });
  });

  it('rejects search queries whose escaped LIKE pattern exceeds D1 limits', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);
    const response = await handleRequest(
      new Request(`https://karaoke.example/api/search?q=${'a'.repeat(49)}`),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Search query is too long: LIKE pattern exceeds 50 UTF-8 bytes',
    });
  });

  it('rejects unsafe cursor offsets', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);
    const response = await handleRequest(
      new Request('https://karaoke.example/api/search?cursor=9007199254740992'),
      { DB: db },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid cursor: 9007199254740992',
    });
  });

  it('returns 404 for non-API routes', async () => {
    const db = createD1WithSongs(FIXTURE_RECORDS);

    const response = await handleRequest(new Request('https://karaoke.example/not-found'), {
      DB: db,
    });

    expect(response.status).toBe(404);
  });
});

async function fetchJson(db: D1DatabaseLike, path: string): Promise<SearchResponseBody> {
  const response = await handleRequest(new Request(`https://karaoke.example${path}`), { DB: db });
  expect(response.status).toBe(200);
  return (await response.json()) as SearchResponseBody;
}

interface SearchResponseBody {
  items: SongRecord[];
  nextCursor: string | null;
}

class NodeSqliteD1 implements D1DatabaseLike {
  constructor(private readonly db: SongDatabase) {}

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    let parameters: unknown[] = [];
    return {
      bind: (...values: unknown[]) => {
        parameters = values;
        return this.prepareBoundStatement(statement, parameters);
      },
      all: async <T>() => ({ results: statement.all() as T[] }),
    };
  }

  private prepareBoundStatement(
    statement: ReturnType<SongDatabase['prepare']>,
    parameters: unknown[],
  ) {
    return {
      all: async <T>() => ({ results: statement.all(...parameters) as T[] }),
    };
  }
}
