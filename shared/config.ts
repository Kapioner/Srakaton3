// Runtime configuration shared by etl/ and server/ (Node only; web/ must not import this).
// Values come from the environment, with an optional .env file in the repo root.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function fromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
}

function parseYears(value: string): [number, number] {
  const [from, to = from] = value.split('-').map((v) => Number(v.trim()));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw new Error(`Invalid DATA_YEARS "${value}", expected e.g. 2001-2025`);
  }
  return [from, to];
}

const env = process.env;

export const config = {
  /** Raw FIRMS CSVs: <dataDir>/<sensor>/<sensor>_<year>_<Country>.csv */
  dataDir: fromRoot(env.DATA_DIR ?? 'sample_data'),
  /** Country names to load, or null for every country found in dataDir. */
  countries: (env.DATA_COUNTRIES ?? 'Greece') === '*' ? null : (env.DATA_COUNTRIES ?? 'Greece').split(',').map((c) => c.trim()),
  years: parseYears(env.DATA_YEARS ?? '2001-2025'),
  /** ETL output: Parquet files and calibration.json */
  processedDir: fromRoot(env.PROCESSED_DIR ?? 'data/processed'),
  /** Grid cell size in degrees; 0.01 deg is about 1 km (the MODIS pixel). */
  gridResDeg: Number(env.GRID_RES_DEG ?? 0.01),
  // Not PORT: dev tools set PORT for the Vite server, and the API must not collide with it.
  port: Number(env.API_PORT ?? 3001),
  /** Serve server/fixtures instead of querying DuckDB. */
  useFixtures: (env.USE_FIXTURES ?? '1') === '1',
};

export type Config = typeof config;
