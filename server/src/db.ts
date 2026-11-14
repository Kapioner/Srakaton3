import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

// One in-memory DuckDB instance per server process. Stage 3 adds read-only views
// over the Parquet files in config.processedDir; queries then live in src/queries/.
let instance: DuckDBInstance | null = null;

async function getInstance(): Promise<DuckDBInstance> {
  instance ??= await DuckDBInstance.create(':memory:');
  return instance;
}

/** Runs one query on its own connection so concurrent requests do not block each other. */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const connection: DuckDBConnection = await (await getInstance()).connect();
  try {
    const reader = await connection.runAndReadAll(sql);
    return reader.getRowObjectsJson() as T[];
  } finally {
    connection.closeSync();
  }
}
