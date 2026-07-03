import { type SongDatabase, openSongDatabase } from '@karaoke/data-store';
import type { PreparedStatementLike, QueryResult, SearchDatabase } from './index.js';

type SqliteValue = string | number | null;
type SqliteStatement = ReturnType<SongDatabase['prepare']>;

export interface SqliteDatabaseOptions {
  inspectStatement?: (sql: string, parameters: readonly SqliteValue[]) => void;
}

export interface OpenSqliteDatabaseOptions extends SqliteDatabaseOptions {
  /**
   * Enables SQLite query-only mode for this connection. This is the default for
   * the self-host API because the HTTP server should only serve a prebuilt DB.
   */
  queryOnly?: boolean;
}

export class SqliteSearchDatabase implements SearchDatabase {
  constructor(
    private readonly db: SongDatabase,
    private readonly options: SqliteDatabaseOptions = {},
  ) {}

  prepare(sql: string): PreparedStatementLike {
    const statement = this.db.prepare(sql);
    return this.boundStatement(statement, []);
  }

  close(): void {
    this.db.close();
  }

  private boundStatement(
    statement: SqliteStatement,
    parameters: readonly SqliteValue[],
  ): PreparedStatementLike {
    return {
      bind: (...values: SqliteValue[]) => this.boundStatement(statement, values),
      all: async <T = Record<string, unknown>>(): Promise<QueryResult<T>> => {
        this.options.inspectStatement?.(statement.sourceSQL, parameters);
        return { results: statement.all(...parameters) as T[] };
      },
    };
  }
}

export function openSqliteSearchDatabase(
  path: string,
  options: OpenSqliteDatabaseOptions = {},
): SqliteSearchDatabase {
  const db = openSongDatabase(path);
  if (options.queryOnly !== false) {
    db.exec('PRAGMA query_only = ON');
  }
  return new SqliteSearchDatabase(db, options);
}
