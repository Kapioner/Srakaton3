// API server configuration, from the environment or <repo>/.env (shared with the ETL).
//
// Defaults are chosen so the server runs on a normal laptop with the Greece sample AND stays alive
// on the world dataset: DuckDB gets a memory cap, a thread cap and a per-query timeout, and heavy
// endpoints have row/cell limits. Override them in .env on a bigger machine.
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const fromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p));
const int = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback);

/** Where the API reads data from. `auto` = the Parquet dataset if it exists, otherwise the fixtures. */
export type DataSourceSetting = 'auto' | 'parquet' | 'fixtures';

function dataSourceSetting(): DataSourceSetting {
  const v = env.DATA_SOURCE?.trim().toLowerCase();
  if (v === 'auto' || v === 'parquet' || v === 'fixtures') return v;
  // Backwards compatible with the stage 0 flag.
  if (env.USE_FIXTURES === '1') return 'fixtures';
  if (env.USE_FIXTURES === '0') return 'parquet';
  return 'auto';
}

/** About a third of the machine's RAM, between 1 and 4 GB: leaves room for the browser and the OS. */
function defaultMemoryLimit(): string {
  const gb = os.totalmem() / 1024 ** 3;
  return `${Math.max(1, Math.min(4, Math.floor(gb / 3)))}GB`;
}

export const config = {
  /** Root of the ETL output (same OUTPUT_DIR as the ETL): hotspots/, harmonized/, calibration/. */
  parquetDir: fromRoot(env.OUTPUT_DIR ?? 'data/parquet'),
  // Not PORT: dev tools set PORT for the Vite server, and the API must not collide with it.
  port: int(env.API_PORT, 3001),
  dataSource: dataSourceSetting(),
  duckdb: {
    memoryLimit: env.DUCKDB_MEMORY_LIMIT ?? defaultMemoryLimit(),
    threads: int(env.DUCKDB_THREADS, Math.max(1, Math.min(4, os.cpus().length))),
    tempDirectory: fromRoot(env.DUCKDB_TEMP_DIR ?? 'data/.duckdb_tmp'),
  },
  limits: {
    /** A query running longer than this is interrupted and answered with 504. */
    queryTimeoutMs: int(env.QUERY_TIMEOUT_MS, 30_000),
    /** Queries allowed to run at the same time; the rest wait in line. */
    maxConcurrentQueries: int(env.MAX_CONCURRENT_QUERIES, 3),
    /** Map grid: the server coarsens the cells until a response has at most this many. */
    gridMaxCells: int(env.GRID_MAX_CELLS, 20_000),
    /** Hard cap on /api/points. */
    pointsMax: int(env.POINTS_MAX, 50_000),
    /** Hard cap on rows in one CSV export. */
    exportMaxRows: int(env.EXPORT_MAX_ROWS, 1_000_000),
  },
};

/** Forward slashes: DuckDB globs need them on Windows. */
export const fwd = (p: string) => p.replaceAll('\\', '/');

export const paths = {
  hotspotsDir: path.join(config.parquetDir, 'hotspots'),
  harmonizedDir: path.join(config.parquetDir, 'harmonized'),
  /** Optional 0.1 deg cell x month aggregate (etl:harmonize builds it); used for whole-month queries. */
  harmonizedMonthlyDir: path.join(config.parquetDir, 'harmonized_monthly'),
  calibrationFile: path.join(config.parquetDir, 'calibration', 'k.parquet'),
  paramsFile: path.join(config.parquetDir, 'calibration', 'params.json'),
  satellitesFile: path.join(config.parquetDir, 'calibration', 'satellites.parquet'),
};

/** DuckDB-friendly glob for one ETL output table, e.g. parquetGlob('harmonized'). */
export function parquetGlob(table: 'hotspots' | 'harmonized' | 'harmonized_monthly'): string {
  return fwd(path.join(config.parquetDir, table, '**', '*.parquet'));
}

export const calibrationFile = fwd(paths.calibrationFile);
