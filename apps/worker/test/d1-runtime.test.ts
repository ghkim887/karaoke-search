import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { D1_SCHEMA_SQL, buildD1ImportSql } from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER_DIST_PATH = join(__dirname, '..', 'dist', 'index.js');
const MIGRATION_PATH = join(__dirname, '..', 'migrations', '0001_init.sql');

const FIXTURE_RECORDS: SongRecord[] = [
  {
    id: 'song-1',
    source_url: 'https://example.com/1',
    title_primary: 'Yoru ni Kakeru',
    title_ko: '밤을 달리다',
    artist_primary: 'YOASOBI',
    artist_ko: null,
    artist_aliases: ['Yoa Alias'],
    karaoke_numbers: { tj: '68000', ky: null, joysound: '123456' },
    categories: ['jpop'],
    crawled_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'song-2',
    source_url: 'https://example.com/2',
    title_primary: 'Senbonzakura',
    title_ko: null,
    artist_primary: 'Kurousa P',
    artist_ko: null,
    karaoke_numbers: { tj: null, ky: '44999', joysound: null },
    categories: ['vocaloid'],
    crawled_at: '2026-01-02T00:00:00.000Z',
  },
];

const miniflares: Miniflare[] = [];

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((mf) => mf.dispose()));
});

describe('worker D1 runtime integration', () => {
  it('keeps the migration SQL in sync with the shared D1 schema', () => {
    expect(normalizeSql(readFileSync(MIGRATION_PATH, 'utf8'))).toBe(normalizeSql(D1_SCHEMA_SQL));
  });

  it('serves search results through Miniflare with a real D1 binding', async () => {
    const mf = await createSeededMiniflare(FIXTURE_RECORDS);

    const response = await mf.dispatchFetch('https://karaoke.example/api/search?q=Yoa%20Alias');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [FIXTURE_RECORDS[0]],
      nextCursor: null,
    });
  });

  it('returns D1-runtime HTTP errors for over-limit LIKE patterns', async () => {
    const mf = await createSeededMiniflare(FIXTURE_RECORDS);

    const response = await mf.dispatchFetch(
      `https://karaoke.example/api/search?q=${'a'.repeat(49)}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Search query is too long: LIKE pattern exceeds 50 UTF-8 bytes',
    });
  });
});

async function createSeededMiniflare(records: readonly SongRecord[]): Promise<Miniflare> {
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_DIST_PATH,
    compatibilityDate: '2026-01-01',
    d1Databases: {
      DB: 'karaoke-test-db',
    },
  });
  miniflares.push(mf);
  const db = await mf.getD1Database('DB');
  await db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  await db.exec(buildD1ImportSql(records, { includeSchema: false }));
  return mf;
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\r\n/g, '\n');
}
