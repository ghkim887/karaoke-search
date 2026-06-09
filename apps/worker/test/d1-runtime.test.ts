import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildD1ImportSql } from '@karaoke/data-store';
import type { SongRecord } from '@karaoke/schema';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WORKER_DIST_PATH = join(__dirname, '..', 'dist', 'index.js');
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const OLD_D1_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)), crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT);
CREATE TABLE IF NOT EXISTS karaoke_numbers (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')), number TEXT, PRIMARY KEY (song_id, provider));
CREATE TABLE IF NOT EXISTS artist_aliases (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position));
CREATE INDEX IF NOT EXISTS idx_songs_sort_order ON songs(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_provider_number ON karaoke_numbers(provider, number) WHERE number IS NOT NULL;`;

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
    crawled_at: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'song-3',
    source_url: 'https://example.com/3',
    title_primary: 'Sparkle',
    title_ko: '스파클',
    artist_primary: 'RADWIMPS',
    artist_ko: '래드윔프스',
    karaoke_numbers: { tj: '62466', ky: null, joysound: null },
    crawled_at: '2026-01-03T00:00:00.000Z',
  },
];

const miniflares: Miniflare[] = [];

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((mf) => mf.dispose()));
});

describe('worker D1 runtime integration', () => {
  it('ships an additive migration for existing D1 search index databases', () => {
    const migration = readFileSync(join(MIGRATIONS_DIR, '0002_search_index.sql'), 'utf8');

    expect(migration).toContain('ALTER TABLE karaoke_numbers ADD COLUMN number_key TEXT');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS search_texts');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS search_tokens');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS search_token_stats');
  });

  it('ships a migration that drops the category dimension from the D1 schema', () => {
    const migration = readFileSync(join(MIGRATIONS_DIR, '0003_drop_categories.sql'), 'utf8');

    expect(migration).toContain('DROP TABLE IF EXISTS song_categories');
    expect(migration).toContain('DROP INDEX IF EXISTS idx_song_categories_category');
    expect(migration).toContain('ALTER TABLE search_texts_new RENAME TO search_texts');
    expect(migration).toContain('ALTER TABLE search_tokens_new RENAME TO search_tokens');
    expect(migration).not.toMatch(/\bcategory\b/);
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

  it('serves three-or-more-character Hangul initial prefixes through real D1', async () => {
    const mf = await createSeededMiniflare(FIXTURE_RECORDS);

    const byArtistInitial = await mf.dispatchFetch(
      'https://karaoke.example/api/search?q=%E3%84%B9%E3%84%B7%E3%85%87',
    );
    const byTitleInitial = await mf.dispatchFetch(
      'https://karaoke.example/api/search?q=%E3%85%85%E3%85%8D%E3%85%8B',
    );

    expect(byArtistInitial.status).toBe(200);
    await expect(byArtistInitial.json()).resolves.toMatchObject({ items: [FIXTURE_RECORDS[2]] });
    expect(byTitleInitial.status).toBe(200);
    await expect(byTitleInitial.json()).resolves.toMatchObject({ items: [FIXTURE_RECORDS[2]] });
  });

  it('upgrades an old D1 schema with 0002 and 0003 before no-schema import', async () => {
    const records: SongRecord[] = [
      {
        ...FIXTURE_RECORDS[0],
        karaoke_numbers: { tj: '068000', ky: null, joysound: '123456' },
      },
    ];
    const mf = await createMiniflare();
    const db = await mf.getD1Database('DB');
    await db.exec(OLD_D1_SCHEMA_SQL);
    await db.exec(readFileSync(join(MIGRATIONS_DIR, '0002_search_index.sql'), 'utf8'));
    await db.exec(readFileSync(join(MIGRATIONS_DIR, '0003_drop_categories.sql'), 'utf8'));
    await db.exec(buildD1ImportSql(records, { includeSchema: false }));

    const byNumberKey = await mf.dispatchFetch('https://karaoke.example/api/search?q=68000');
    const byIndexedText = await mf.dispatchFetch(
      'https://karaoke.example/api/search?q=Yoa%20Alias',
    );

    expect(byNumberKey.status).toBe(200);
    await expect(byNumberKey.json()).resolves.toMatchObject({ items: [records[0]] });
    expect(byIndexedText.status).toBe(200);
    await expect(byIndexedText.json()).resolves.toMatchObject({ items: [records[0]] });
  });

  it('accepts long queries without D1 LIKE-pattern errors at runtime', async () => {
    const mf = await createSeededMiniflare(FIXTURE_RECORDS);

    const response = await mf.dispatchFetch(
      `https://karaoke.example/api/search?q=${'a'.repeat(49)}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
  });
});

async function createSeededMiniflare(records: readonly SongRecord[]): Promise<Miniflare> {
  const mf = await createMiniflare();
  const db = await mf.getD1Database('DB');
  for (const migrationPath of migrationPaths()) {
    await db.exec(readFileSync(migrationPath, 'utf8'));
  }
  await db.exec(buildD1ImportSql(records, { includeSchema: false }));
  return mf;
}

async function createMiniflare(): Promise<Miniflare> {
  const workerScript = readFileSync(WORKER_DIST_PATH, 'utf8').replaceAll(
    '@karaoke/search',
    '../../../packages/search/dist/index.js',
  );
  const mf = new Miniflare({
    modules: true,
    modulesRoot: join(__dirname, '..', '..', '..'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
    script: workerScript,
    scriptPath: WORKER_DIST_PATH,
    compatibilityDate: '2026-01-01',
    d1Databases: {
      DB: 'karaoke-test-db',
    },
  });
  miniflares.push(mf);
  return mf;
}

function migrationPaths(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort()
    .map((fileName) => join(MIGRATIONS_DIR, fileName));
}
