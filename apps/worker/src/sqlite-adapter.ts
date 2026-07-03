import { type SongDatabase, openSongDatabase } from '@karaoke/data-store';
import type { D1DatabaseLike, D1PreparedStatementLike, D1Result } from './index.js';

type SqliteValue = string | number | null;
type SqliteStatement = ReturnType<SongDatabase['prepare']>;

export interface SqliteD1Options {
  inspectStatement?: (sql: string, parameters: readonly SqliteValue[]) => void;
}

export interface OpenSqliteD1Options extends SqliteD1Options {
  /**
   * Enables SQLite query-only mode for this connection. This is the default for
   * the self-host API because the HTTP server should only serve a prebuilt DB.
   */
  queryOnly?: boolean;
}

export class SqliteD1Database implements D1DatabaseLike {
  constructor(
    private readonly db: SongDatabase,
    private readonly options: SqliteD1Options = {},
  ) {}

  prepare(sql: string): D1PreparedStatementLike {
    const statement = this.db.prepare(sql);
    return this.boundStatement(statement, []);
  }

  close(): void {
    this.db.close();
  }

  private boundStatement(
    statement: SqliteStatement,
    parameters: readonly SqliteValue[],
  ): D1PreparedStatementLike {
    return {
      bind: (...values: SqliteValue[]) => this.boundStatement(statement, values),
      all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => {
        this.options.inspectStatement?.(statement.sourceSQL, parameters);
        return { results: statement.all(...parameters) as T[] };
      },
    };
  }
}

export function openSqliteD1Database(
  path: string,
  options: OpenSqliteD1Options = {},
): SqliteD1Database {
  const db = openSongDatabase(path);
  if (options.queryOnly !== false) {
    db.exec('PRAGMA query_only = ON');
  }
  return new SqliteD1Database(db, options);
}
