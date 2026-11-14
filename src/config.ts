import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  liveDbPath: string;
  firmsBaseUrl: string;
  pollingEnabled: boolean;
  retentionDays: number;
  /** A paused mode (archive/forecast) falls back to realtime after this long; null = never. */
  pauseResumeMinutes: number | null;
  tmpDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3001),
    host: env.HOST ?? '0.0.0.0',
    liveDbPath: env.LIVE_DB_PATH ?? path.resolve('..', 'data', 'live', 'live.duckdb'),
    firmsBaseUrl: (env.FIRMS_BASE_URL ?? 'https://firms.modaps.eosdis.nasa.gov/data/active_fire').replace(/\/+$/, ''),
    pollingEnabled: (env.LIVE_POLLING ?? 'true') !== 'false',
    retentionDays: Number(env.LIVE_RETENTION_DAYS ?? 14),
    pauseResumeMinutes: env.LIVE_PAUSE_RESUME_MINUTES === '0' ? null : Number(env.LIVE_PAUSE_RESUME_MINUTES ?? 60),
    tmpDir: env.LIVE_TMP_DIR ?? path.join(os.tmpdir(), 'firewatch-live'),
  };
}
