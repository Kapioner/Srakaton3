// The one DuckDB instance of the server process, with the guard rails that keep it alive on big data:
// memory and thread caps, a queue for concurrent queries, and a timeout that interrupts runaway queries.
import { mkdirSync } from 'node:fs';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { config, fwd } from './config.ts';

export class QueryTimeout extends Error {
  statusCode = 504;
}

let instance: Promise<DuckDBInstance> | null = null;

function getInstance(): Promise<DuckDBInstance> {
  instance ??= (async () => {
    mkdirSync(config.duckdb.tempDirectory, { recursive: true });
    return DuckDBInstance.create(':memory:', {
      memory_limit: config.duckdb.memoryLimit,
      threads: String(config.duckdb.threads),
      temp_directory: fwd(config.duckdb.tempDirectory),
      // Results do not need input order; this lets DuckDB stream and use less memory.
      preserve_insertion_order: 'false',
    });
  })();
  return instance;
}

// ---- simple FIFO semaphore: at most N queries at once --------------------------------------------
let running = 0;
const waiting: (() => void)[] = [];

async function acquire() {
  if (running < config.limits.maxConcurrentQueries) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
}

function release() {
  running--;
  waiting.shift()?.();
}

/**
 * Runs one SQL statement on its own connection. Rows come back as JSON-safe objects
 * (BIGINT and DECIMAL arrive as strings, so convert numbers with Number()).
 */
export async function query<T = Record<string, unknown>>(sql: string, timeoutMs = config.limits.queryTimeoutMs): Promise<T[]> {
  await acquire();
  let connection: DuckDBConnection | null = null;
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  try {
    connection = await (await getInstance()).connect();
    const conn = connection;
    timer = setTimeout(() => {
      timedOut = true;
      conn.interrupt();
    }, timeoutMs);
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJson() as T[];
  } catch (err) {
    if (timedOut) throw new QueryTimeout(`Query took longer than ${Math.round(timeoutMs / 1000)} s. Narrow the region or the date range.`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    connection?.closeSync();
    release();
  }
}

/** Runs a statement that returns nothing (CREATE VIEW, COPY ...). */
export async function exec(sql: string, timeoutMs?: number): Promise<void> {
  await query(sql, timeoutMs);
}

/** SQL string literal. */
export const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
