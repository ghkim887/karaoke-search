import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  D1_SCHEMA_SQL,
  type SongDatabase,
  createSongDatabase,
  openSongDatabase,
} from '@karaoke/data-store';
import { afterEach, describe, expect, it } from 'vitest';

// The D1 schema exists in two independently-maintained forms:
//   1. apps/worker/migrations/*.sql — the append-only chain that owns the
//      remote D1 database (applied via `wrangler d1 migrations apply`).
//   2. packages/data-store D1_SCHEMA_SQL — the declared schema used by the
//      node:sqlite path (createSongDatabase) and the D1 SQL exports.
// Nothing else asserts those two converge; this test replays both into fresh
// node:sqlite databases and compares the resulting schema state, so adding a
// column to one side without the other fails CI with a structured diff.

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

const openDatabases: SongDatabase[] = [];

afterEach(() => {
  while (openDatabases.length > 0) {
    openDatabases.pop()?.close();
  }
});

function openMemoryDatabase(): SongDatabase {
  const db = openSongDatabase(':memory:');
  openDatabases.push(db);
  return db;
}

function migrationFileNames(): string[] {
  // Wrangler applies migrations in ascending filename order; the zero-padded
  // NNNN_ prefix makes lexicographic order equal to chronological order.
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(name).toMatch(/^\d{4}_/);
  }
  return names;
}

function openMigratedDatabase(): SongDatabase {
  const db = openMemoryDatabase();
  for (const name of migrationFileNames()) {
    // node:sqlite's exec() runs every statement in the string, so a whole
    // migration file can be applied verbatim. Manual semicolon splitting is
    // deliberately avoided — the migrations contain quoted string literals
    // (CHECK ... IN ('tj', 'ky', 'joysound')) that naive splitting could
    // corrupt.
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }
  return db;
}

function openDeclaredDatabase(schemaSql: string): SongDatabase {
  const db = openMemoryDatabase();
  db.exec(schemaSql);
  return db;
}

// Normalization decisions (each forgives a cosmetic difference only — any
// semantic difference in columns, constraints, or indexes still fails):
//   - Collapse whitespace runs: the declared schema is single-line today, but
//     future migrations may be formatted across lines.
//   - Strip IF NOT EXISTS: SQLite already omits it from the sqlite_master SQL
//     it stores, but that is an implementation detail of the SQLite build —
//     strip defensively so a version change cannot break the comparison.
//   - Unquote plain double-quoted identifiers: migration 0003 rebuilds
//     search_texts/search_tokens via CREATE ... RENAME TO, and SQLite rewrites
//     the stored CREATE statement with the new table name double-quoted
//     ('CREATE TABLE "search_texts" (...)'). The declared schema spells the
//     same name unquoted. Only [A-Za-z_][A-Za-z0-9_]* identifiers are
//     unquoted, so quoting that is load-bearing (reserved words, spaces) is
//     preserved and would still surface as a diff.
// NOT normalized on purpose: column order inside CREATE TABLE, constraint
// text, DEFAULT clauses, partial-index WHERE clauses — those are semantic.
// Note: wrangler's own migration-bookkeeping table (d1_migrations) is created
// by `wrangler d1 migrations apply`, not by the migration SQL itself, so it
// appears on neither side here and needs no exclusion.
function normalizeSql(sql: string | null): string | null {
  if (sql === null) {
    return null;
  }
  return sql
    .replace(/\s+/gu, ' ')
    .replace(/\bIF NOT EXISTS\s+/giu, '')
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"/gu, '$1')
    .trim();
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface SqliteMasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexSnapshot {
  unique: number;
  origin: string;
  partial: number;
  sql: string | null;
  columns: IndexInfoRow[];
}

interface TableSnapshot {
  sql: string | null;
  columns: TableInfoRow[];
  indexes: Record<string, IndexSnapshot>;
  foreignKeys: ForeignKeyRow[];
}

interface SchemaSnapshot {
  // Every sqlite_master object (tables, indexes, and any future views or
  // triggers), keyed `type:name` with its normalized SQL. Internal
  // sqlite_autoindex_* rows are included; they carry NULL SQL and identical
  // names on both sides as long as the table definitions match.
  objects: Record<string, { tblName: string; sql: string | null }>;
  // Structural state per table via PRAGMAs, robust against SQL-text quirks.
  tables: Record<string, TableSnapshot>;
}

function snapshotSchema(db: SongDatabase): SchemaSnapshot {
  const masterRows = db
    .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name')
    .all() as unknown as SqliteMasterRow[];

  const objects: SchemaSnapshot['objects'] = {};
  for (const row of masterRows) {
    objects[`${row.type}:${row.name}`] = {
      tblName: row.tbl_name,
      sql: normalizeSql(row.sql),
    };
  }

  const tables: SchemaSnapshot['tables'] = {};
  for (const row of masterRows) {
    if (row.type !== 'table') {
      continue;
    }
    const table = quoteIdentifier(row.name);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as TableInfoRow[];

    const indexes: Record<string, IndexSnapshot> = {};
    const indexList = db.prepare(`PRAGMA index_list(${table})`).all() as unknown as IndexListRow[];
    for (const index of indexList) {
      const indexSql =
        objects[`index:${index.name}`]?.sql ??
        // Internal PK/UNIQUE autoindexes have no sqlite_master SQL.
        null;
      indexes[index.name] = {
        unique: index.unique,
        origin: index.origin,
        partial: index.partial,
        sql: indexSql,
        columns: (
          db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as unknown as (
            | IndexInfoRow
            | Record<string, unknown>
          )[]
        ).map((info) => ({
          seqno: (info as IndexInfoRow).seqno,
          cid: (info as IndexInfoRow).cid,
          name: (info as IndexInfoRow).name,
        })),
      };
    }

    const foreignKeys = (
      db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as ForeignKeyRow[]
    )
      .map((fk) => ({
        table: fk.table,
        from: fk.from,
        to: fk.to,
        on_update: fk.on_update,
        on_delete: fk.on_delete,
        match: fk.match,
      }))
      .sort((a, b) => a.from.localeCompare(b.from) || a.table.localeCompare(b.table));

    tables[row.name] = { sql: normalizeSql(row.sql), columns, indexes, foreignKeys };
  }

  return { objects, tables };
}

// Asserts parity object-by-object so a failure names the exact table or index
// that drifted (and shows both sides) instead of dumping the whole schema.
function expectSchemaParity(actual: SchemaSnapshot, expected: SchemaSnapshot): void {
  // Name-level check first so a missing/extra table or index reads as a
  // one-line set difference.
  expect(Object.keys(actual.objects).sort()).toEqual(Object.keys(expected.objects).sort());
  for (const [key, expectedObject] of Object.entries(expected.objects)) {
    expect(actual.objects[key], `sqlite_master SQL for ${key}`).toEqual(expectedObject);
  }
  for (const [name, expectedTable] of Object.entries(expected.tables)) {
    expect(actual.tables[name], `PRAGMA state for table ${name}`).toEqual(expectedTable);
  }
  // Belt-and-suspenders so nothing escapes the per-object loops above.
  expect(actual).toEqual(expected);
}

describe('D1 schema parity', () => {
  it('migration chain replay produces exactly the declared data-store schema', () => {
    const migrated = snapshotSchema(openMigratedDatabase());
    const declared = snapshotSchema(openDeclaredDatabase(D1_SCHEMA_SQL));

    expectSchemaParity(migrated, declared);
  });

  it('createSongDatabase on a fresh database matches the declared schema', () => {
    // createSongDatabase layers ensureTableColumn mini-migrations on top of
    // D1_TABLE_SCHEMA_SQL; on a fresh database those must be no-ops that land
    // on exactly D1_SCHEMA_SQL.
    const created = openMemoryDatabase();
    createSongDatabase(created);

    expectSchemaParity(
      snapshotSchema(created),
      snapshotSchema(openDeclaredDatabase(D1_SCHEMA_SQL)),
    );
  });

  it('detects schema drift (comparator self-check)', () => {
    // Permanent negative proof that the comparator is not normalizing real
    // differences away: a declared schema with one extra column must differ.
    const drifted = D1_SCHEMA_SQL.replace(
      'crawled_at TEXT NOT NULL,',
      'crawled_at TEXT NOT NULL, drift_canary TEXT,',
    );
    expect(drifted).not.toBe(D1_SCHEMA_SQL);

    const migrated = snapshotSchema(openMigratedDatabase());
    const declared = snapshotSchema(openDeclaredDatabase(drifted));

    expect(migrated).not.toEqual(declared);
    expect(declared.tables.songs?.columns.map((column) => column.name)).toContain('drift_canary');
    expect(migrated.tables.songs?.columns.map((column) => column.name)).not.toContain(
      'drift_canary',
    );
  });
});
