import type { IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  type SongDatabase,
  createSongDatabase,
  importSongs,
  openSongDatabase,
} from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRateLimit,
  createKaraokeSearchNodeServer,
  createRateLimiterState,
  isCliEntrypoint,
} from '../src/node-server.js';
import { SqliteSearchDatabase } from '../src/sqlite-adapter.js';

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
    const server = createKaraokeSearchNodeServer({ db: new SqliteSearchDatabase(sqlite) });
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
      db: new SqliteSearchDatabase(sqlite),
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
      db: new SqliteSearchDatabase(sqlite),
      corsOrigin: 'https://karaokedb.pages.dev',
    });
    const listener = await listenOnEphemeralPort(server);
    servers.push(listener);

    const preflight = await fetch(`${listener.origin}/api/search?q=610001`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://karaokedb.pages.dev',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://karaokedb.pages.dev',
    );
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('can restrict CORS origin and rate-limit repeated clients', async () => {
    const sqlite = seedSqlite();
    const server = createKaraokeSearchNodeServer({
      db: new SqliteSearchDatabase(sqlite),
      corsOrigin: 'https://karaokedb.pages.dev',
      rateLimit: { windowMs: 60_000, maxRequests: 1 },
    });
    const listener = await listenOnEphemeralPort(server);
    servers.push(listener);

    const first = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`);
    const second = await fetch(`${listener.origin}/api/search?q=%E7%B5%90%E6%9D%9F`);

    expect(first.headers.get('access-control-allow-origin')).toBe('https://karaokedb.pages.dev');
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toEqual({ error: 'Rate limit exceeded' });
  });
});

describe('rate-limit bucket eviction', () => {
  const fakeReq = (ip: string): IncomingMessage =>
    ({ socket: { remoteAddress: ip }, headers: {} }) as unknown as IncomingMessage;

  it('keeps identical allow/deny decisions for a single client across a window boundary', () => {
    const state = createRateLimiterState();
    let now = 0;
    const options = { windowMs: 60_000, maxRequests: 2, now: () => now };
    const req = fakeReq('203.0.113.7');

    expect(checkRateLimit(req, options, state, false)).toBe(false); // 1st
    expect(checkRateLimit(req, options, state, false)).toBe(false); // 2nd (== max)
    expect(checkRateLimit(req, options, state, false)).toBe(true); // 3rd exceeds
    now = 60_000; // window rolls over
    expect(checkRateLimit(req, options, state, false)).toBe(false); // fresh window
  });

  it('evicts expired-window buckets so distinct one-shot clients cannot grow the map unbounded', () => {
    const state = createRateLimiterState();
    let now = 0;
    const options = { windowMs: 60_000, maxRequests: 5, now: () => now };

    // 1000 distinct clients, each arriving a full window after the last, so
    // every earlier bucket's window has expired by the time the next hits.
    for (let i = 0; i < 1000; i += 1) {
      now = i * 60_000;
      expect(
        checkRateLimit(fakeReq(`10.0.${(i >> 8) & 255}.${i & 255}`), options, state, false),
      ).toBe(false);
    }

    // Without eviction the map would retain ~1000 dead buckets; the lazy sweep
    // bounds it to the live window (a handful), not the number of clients seen.
    expect(state.buckets.size).toBeLessThanOrEqual(2);
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
