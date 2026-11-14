import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Folder of this server package (the one with package.json), wherever it was unpacked. */
export const SERVER_ROOT = path.resolve(import.meta.dirname, '..');

const hasEtl = (dir: string) => fs.existsSync(path.join(dir, 'src', 'harmonization.ts'));

/**
 * Finds the ETL package: `ETL_DIR` if set, otherwise an `etl/` folder next to the server or in any
 * parent folder (monorepo layout `<repo>/server` + `<repo>/etl`). `null` when there is none.
 */
export function findEtlDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ETL_DIR) {
    const dir = path.resolve(env.ETL_DIR);
    if (!hasEtl(dir)) throw new Error(`ETL_DIR=${dir} does not contain src/harmonization.ts`);
    return dir;
  }
  for (let dir = SERVER_ROOT; ; dir = path.dirname(dir)) {
    if (hasEtl(path.join(dir, 'etl'))) return path.join(dir, 'etl');
    if (path.dirname(dir) === dir) return null;
  }
}

export interface AppConfig {
  port: number;
  host: string;
  liveDbPath: string;
  /** Root of the ETL Parquet dataset (the ETL's OUTPUT_DIR); `hotspots/` inside it is read. */
  archiveDir: string;
  /** ETL package folder; harmonization parameters are read from it. `null` = not found. */
  etlDir: string | null;
  firmsBaseUrl: string;
  pollingEnabled: boolean;
  /** Live rows older than this are dropped even if the archive does not cover them yet. */
  retentionDays: number;
  /** A paused mode (archive/forecast) falls back to realtime after this long; null = never. */
  pauseResumeMinutes: number | null;
  tmpDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const etlDir = findEtlDir(env);
  // Relative data paths resolve against the repo root (the ETL's parent), as in the ETL itself;
  // without an ETL next to it, against the server folder.
  const root = path.resolve(env.REPO_ROOT ?? (etlDir ? path.dirname(etlDir) : SERVER_ROOT));
  return {
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? '0.0.0.0',
    liveDbPath: path.resolve(root, env.LIVE_DB_PATH ?? 'data/live/live.duckdb'),
    archiveDir: path.resolve(root, env.ARCHIVE_DIR ?? env.OUTPUT_DIR ?? 'data/parquet'),
    etlDir,
    firmsBaseUrl: (env.FIRMS_BASE_URL ?? 'https://firms.modaps.eosdis.nasa.gov/data/active_fire').replace(/\/+$/, ''),
    pollingEnabled: (env.LIVE_POLLING ?? 'true') !== 'false',
    retentionDays: Number(env.LIVE_RETENTION_DAYS ?? 30),
    pauseResumeMinutes: env.LIVE_PAUSE_RESUME_MINUTES === '0' ? null : Number(env.LIVE_PAUSE_RESUME_MINUTES ?? 60),
    tmpDir: env.LIVE_TMP_DIR ?? path.join(os.tmpdir(), 'firewatch-live'),
  };
}
