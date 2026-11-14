import os from 'node:os';
import path from 'node:path';

/** Monorepo root (server/src → ../..). Relative paths in env vars resolve against it, as in the ETL. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

export interface AppConfig {
  port: number;
  host: string;
  liveDbPath: string;
  /** Root of the ETL Parquet dataset (the ETL's OUTPUT_DIR); `hotspots/` inside it is read. */
  archiveDir: string;
  firmsBaseUrl: string;
  pollingEnabled: boolean;
  /** Live rows older than this are dropped even if the archive does not cover them yet. */
  retentionDays: number;
  /** A paused mode (archive/forecast) falls back to realtime after this long; null = never. */
  pauseResumeMinutes: number | null;
  tmpDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? '0.0.0.0',
    liveDbPath: path.resolve(REPO_ROOT, env.LIVE_DB_PATH ?? 'data/live/live.duckdb'),
    archiveDir: path.resolve(REPO_ROOT, env.ARCHIVE_DIR ?? env.OUTPUT_DIR ?? 'data/parquet'),
    firmsBaseUrl: (env.FIRMS_BASE_URL ?? 'https://firms.modaps.eosdis.nasa.gov/data/active_fire').replace(/\/+$/, ''),
    pollingEnabled: (env.LIVE_POLLING ?? 'true') !== 'false',
    retentionDays: Number(env.LIVE_RETENTION_DAYS ?? 30),
    pauseResumeMinutes: env.LIVE_PAUSE_RESUME_MINUTES === '0' ? null : Number(env.LIVE_PAUSE_RESUME_MINUTES ?? 60),
    tmpDir: env.LIVE_TMP_DIR ?? path.join(os.tmpdir(), 'firewatch-live'),
  };
}
