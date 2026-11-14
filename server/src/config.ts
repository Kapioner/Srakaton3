// API server configuration, from the environment or <repo>/.env (shared with the ETL).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const fromRoot = (p: string) => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p));

export const config = {
  /** Root of the ETL output (same OUTPUT_DIR as the ETL): hotspots/, harmonized/, calibration/. */
  parquetDir: fromRoot(env.OUTPUT_DIR ?? 'data/parquet'),
  // Not PORT: dev tools set PORT for the Vite server, and the API must not collide with it.
  port: Number(env.API_PORT ?? 3001),
  /** Serve server/fixtures instead of querying DuckDB. */
  useFixtures: (env.USE_FIXTURES ?? '1') === '1',
};

/** Forward slashes: DuckDB globs need them on Windows. */
const fwd = (p: string) => p.replaceAll('\\', '/');

/** DuckDB-friendly glob for one ETL output table, e.g. parquetGlob('harmonized'). */
export function parquetGlob(table: 'hotspots' | 'harmonized'): string {
  return fwd(path.join(config.parquetDir, table, '**', '*.parquet'));
}

export const calibrationFile = fwd(path.join(config.parquetDir, 'calibration', 'k.parquet'));
