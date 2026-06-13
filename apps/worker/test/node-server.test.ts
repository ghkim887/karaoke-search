import { pathToFileURL } from 'node:url';
import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createKaraokeSearchNodeServer, isCliEntrypoint } from '../src/node-server.js';
import { SqliteD1Database } from '../src/sqlite-adapter.js';

const openDatabases: SongDatabase[] = [];
const servers: Awaited<ReturnType<typeof listenOnEphemeralPort>>[] = [];

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'server-1',
    source_url: 'https://example.com/server-1',
    title_primary: '青春コンプレックス',
    title_ko: null,
    artist_primary: '結束バンド',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: null, joysound: '610001' },
    crawled_at: '2026-01-01T00:00:00.000Z',
  },
];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

describe('Node self-host CLI entrypoint', () => {
  it('detects direct node execution using pathToFileURL-safe path comparison', () => {
    const scriptPath = 'C:\\example\\dist\\node-server.js';
    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(isCliEntrypoint(pathToFileURL(scriptPath).href, undefined)).toBe(false);
  });
});
describe('Node self-host API server', () => {
  it('serves health and API search over HTTP using the shared Worker handler', async () => {
    const sqlite = seedSqlite();
    const server = createKaraokeSearchNodeServer({ db: new SqliteD1Database(sqlite) });
    const listener = await listenOnEphemeralPort(server);
    servers.push(listener);

    const health = await fetch(`${listener.origin}/healthz`);
    const search = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`);

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });
    expect(search.status).toBe(200);
    await expect(search.json()).resolves.toEqual({ items: FIXTURE_RECORDS, nextCursor: null });
  });

  it('does not trust spoofed forwarded IP headers for rate limiting by default', async () => {
    const sqlite = seedSqlite();
    const server = createKaraokeSearchNodeServer({
      db: new SqliteD1Database(sqlite),
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
    });
    const listener = await listenOnEphemeralPort(server);
    servers.push(listener);

    const first = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`, {
      headers: { 'cf-connecting-ip': '198.51.100.10' },
    });
    const second = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`, {
      headers: { 'cf-connecting-ip': '198.51.100.11' },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
  it('allows Chrome Private Network Access preflights for the pinned Pages origin', async () => {
    const sqlite = seedSqlite();
    const server = createKaraokeSearchNodeServer({
      db: new SqliteD1Database(sqlite),
      corsOrigin: 'https://ghkim887.github.io',
    });
    const listener = await listenOnEphemeralPort(server);
    servers.push(listener);

    const preflight = await fetch(`${listener.origin}/api/search?q=610001`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://ghkim887.github.io',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://ghkim887.github.io');
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('can restrict CORS origin and rate-limit repeated clients', async () => {
    const sqlite = seedSqlite();
    const server = createKaraokeSearchNodeServer({
      db: new SqliteD1Database(sqlite),
      corsOrigin: 'https://ghkim887.github.io',
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
    });
    const listener = await listenOnEphemeralPort(server);
    servers.push(listener);

    const first = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`);
    const second = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`);

    expect(first.headers.get('access-control-allow-origin')).toBe('https://ghkim887.github.io');
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({ error: 'Rate limit exceeded' });
  });
});

function seedSqlite(): SongDatabase {
  const sqlite = openSongDatabase(':memory:');
  openDatabases.push(sqlite);
  createSongDatabase(sqlite);
  importSongs(sqlite, FIXTURE_RECORDS);
  return sqlite;
}

function listenOnEphemeralPort(server: ReturnType<typeof createKaraokeSearchNodeServer>) {
  return new Promise<{ server: typeof server; origin: string }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server did not bind to a TCP address'));
        return;
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}
