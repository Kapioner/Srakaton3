import fs from 'node:fs';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';

export type SqlParams = Record<string, string | number | boolean | null>;
export type Row = Record<string, any>;

/**
 * Thin wrapper over the single DuckDB instance of the process.
 * Everything above it talks SQL through repositories, so the engine can be swapped.
 */
export class Database {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  static async open(dbPath: string): Promise<Database> {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const instance = await DuckDBInstance.create(dbPath);
    const connection = await instance.connect();
    await connection.run("SET TimeZone = 'UTC'");
    return new Database(instance, connection);
  }

  /** Runs a statement and returns the number of changed rows. */
  async run(sql: string, params: SqlParams = {}): Promise<number> {
    const result = await this.connection.run(sql, params);
    return Number(result.rowsChanged);
  }

  async all<T extends Row = Row>(sql: string, params: SqlParams = {}): Promise<T[]> {
    const reader = await this.connection.runAndReadAll(sql, params);
    return reader.getRowObjectsJson() as T[];
  }

  /**
   * Streams a result chunk by chunk on a dedicated connection, so a long export
   * is not invalidated by other queries running meanwhile.
   */
  async *stream(sql: string, params: SqlParams = {}): AsyncGenerator<Row[]> {
    const connection = await this.instance.connect();
    try {
      await connection.run("SET TimeZone = 'UTC'");
      const result = await connection.stream(sql, params);
      yield* result.yieldRowObjectJson();
    } finally {
      connection.closeSync();
    }
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}

/** Formats a Date as a UTC `TIMESTAMP` literal value understood by DuckDB. */
export function toSqlTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}
