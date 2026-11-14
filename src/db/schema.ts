import type { Database } from './database.js';

/**
 * Columns of one normalized hotspot, exactly as written by the ETL (etl/src/sql.ts, step 1).
 * Live rows use the same schema so archive and live data can be read as one table.
 * A test compares this list with the ETL's real output.
 */
export const HOTSPOT_COLUMNS = [
  ['latitude', 'DOUBLE'],
  ['longitude', 'DOUBLE'],
  ['acq_date', 'DATE'],
  ['acq_time', 'VARCHAR'],
  ['acq_datetime', 'TIMESTAMP'],
  ['sensor', 'VARCHAR'],
  ['satellite', 'VARCHAR'],
  ['confidence', 'VARCHAR'],
  ['confidence_raw', 'VARCHAR'],
  ['frp', 'DOUBLE'],
  ['bt_mir', 'DOUBLE'],
  ['bt_tir', 'DOUBLE'],
  ['scan', 'DOUBLE'],
  ['track', 'DOUBLE'],
  ['pixel_km2', 'DOUBLE'],
  ['daynight', 'VARCHAR'],
  ['type', 'TINYINT'],
  ['version', 'VARCHAR'],
  ['source', 'VARCHAR'],
  ['country', 'VARCHAR'],
  ['year', 'INTEGER'],
] as const;

export const HOTSPOT_COLUMN_NAMES = HOTSPOT_COLUMNS.map(([name]) => name);

/** Idempotent schema setup for the live (near-real-time) feature. */
export async function migrate(db: Database): Promise<void> {
  // Earlier versions stored their own harmonized columns. Live rows are a cache of FIRMS files,
  // so an old table is simply dropped and refilled by the next ingest.
  const [legacy] = await db.all(
    `SELECT count(*)::INTEGER AS n FROM information_schema.columns
     WHERE table_name = 'live_hotspots' AND column_name = 'cell_x'`,
  );
  if (legacy.n > 0) await db.run('DROP TABLE live_hotspots');

  await db.run(`
    CREATE TABLE IF NOT EXISTS live_hotspots (
      ${HOTSPOT_COLUMNS.map(([name, type]) => `"${name}" ${type}`).join(',\n      ')},
      ingested_at TIMESTAMP NOT NULL,
      -- Re-ingesting overlapping FIRMS files (24h/48h/7d windows) is idempotent.
      PRIMARY KEY (satellite, acq_datetime, latitude, longitude)
    )`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS live_scope (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      scope      VARCHAR   NOT NULL,
      updated_at TIMESTAMP NOT NULL
    )`);

  await db.run(`
    CREATE TABLE IF NOT EXISTS live_ingest_runs (
      started_at  TIMESTAMP NOT NULL,
      finished_at TIMESTAMP NOT NULL,
      status      VARCHAR   NOT NULL,  -- ok | partial | failed
      inserted    INTEGER   NOT NULL,
      details     VARCHAR   NOT NULL   -- JSON: per-sensor outcome
    )`);
}
