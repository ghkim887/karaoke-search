/**
 * CONTRACT TEST: /api/meta `dbUpdatedAt` format <-> Footer runtime-update regex.
 *
 * `apps/worker` `computeDbUpdatedAt` (src/index.ts) truncates MAX(crawled_at)
 * to a YYYY-MM-DD date, or returns '' for an empty songs table.
 * `apps/web/src/components/Footer.astro` only swaps in the live date when the
 * payload matches `/^\d{4}-\d{2}-\d{2}$/` — an otherwise UNDOCUMENTED cross-app
 * coupling. If the worker's format ever drifts (e.g. it starts emitting a full
 * ISO timestamp, or a partial date), the Footer would silently ignore the live
 * value and keep the build-time date, with no test noticing. This freezes the
 * contract from the worker side so such drift fails loudly here.
 *
 * Footer regex source of truth: apps/web/src/components/Footer.astro
 * (the `/^\d{4}-\d{2}-\d{2}$/` guard applied to `data.dbUpdatedAt`).
 *
 * Kept separate from test/search.test.ts on purpose (file separation is
 * deliberate); mirrors that file's in-memory SQLite fixture pattern.
 */
import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { type SearchDatabase, handleRequest } from '../src/index.js';
import { SqliteSearchDatabase } from '../src/sqlite-adapter.js';

// Byte-for-byte mirror of Footer.astro's runtime-update guard. Held as a local
// literal (Footer.astro is an Astro component, not an importable module here);
// the two MUST stay identical — that is exactly the contract this file guards.
const FOOTER_DB_UPDATED_AT_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const openDatabases: SongDatabase[] = [];

function createSearchDatabaseWithSongs(records: readonly SongRecord[]): SearchDatabase {
  const sqlite = openSongDatabase(':memory:');
  openDatabases.push(sqlite);
  createSongDatabase(sqlite);
  importSongs(sqlite, records);
  return new SqliteSearchDatabase(sqlite);
}

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

const RECORDS: SongRecord[] = [
  {
    id: 'meta-song-1',
    source_url: 'https://example.com/1',
    title_primary: 'First',
    title_ko: null,
    artist_primary: 'Artist One',
    artist_ko: null,
    karaoke_numbers: { tj: '11111', ky: null, joysound: null },
    crawled_at: '2026-03-14T09:30:00.000Z',
  },
  {
    id: 'meta-song-2',
    source_url: 'https://example.com/2',
    title_primary: 'Second',
    title_ko: null,
    artist_primary: 'Artist Two',
    artist_ko: null,
    karaoke_numbers: { tj: '22222', ky: null, joysound: null },
    // Latest crawled_at — MAX() picks this; time-of-day must be truncated away.
    crawled_at: '2026-03-15T23:59:59.000Z',
  },
];

async function fetchDbUpdatedAt(db: SearchDatabase): Promise<{ status: number; value: unknown }> {
  const response = await handleRequest(new Request('https://karaoke.example/api/meta'), { db });
  const body = (await response.json()) as { dbUpdatedAt?: unknown };
  return { status: response.status, value: body.dbUpdatedAt };
}

describe('/api/meta <-> Footer dbUpdatedAt date contract', () => {
  it('returns a date-only YYYY-MM-DD string that matches the Footer regex (non-empty DB)', async () => {
    const db = createSearchDatabaseWithSongs(RECORDS);

    const { status, value } = await fetchDbUpdatedAt(db);

    expect(status).toBe(200);
    expect(typeof value).toBe('string');
    const dbUpdatedAt = value as string;
    // Exact-format contract: anchored regex forbids any trailing time component.
    expect(dbUpdatedAt).toMatch(FOOTER_DB_UPDATED_AT_REGEX);
    expect(dbUpdatedAt).toHaveLength(10);
    // MAX(crawled_at) = 2026-03-15T23:59:59Z truncated to its date; the Footer
    // would reject anything longer, so the worker MUST drop the time.
    expect(dbUpdatedAt).toBe('2026-03-15');
  });

  it("returns exactly '' (which the Footer regex rejects, keeping the build-time date) for an empty DB", async () => {
    const db = createSearchDatabaseWithSongs([]);

    const { status, value } = await fetchDbUpdatedAt(db);

    expect(status).toBe(200);
    expect(value).toBe('');
    // The empty sentinel must NOT match the Footer regex — that is how the
    // footer degrades to the server-rendered date instead of blanking it.
    expect(FOOTER_DB_UPDATED_AT_REGEX.test(value as string)).toBe(false);
  });
});
