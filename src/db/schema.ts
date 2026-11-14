import type { Database } from './database.js';

/** Idempotent schema setup for the live (near-real-time) feature. */
export async function migrate(db: Database): Promise<void> {
  // Harmonized hotspots. The primary key makes re-ingesting overlapping FIRMS files idempotent.
  await db.run(`
    CREATE TABLE IF NOT EXISTS live_hotspots (
      latitude         DOUBLE    NOT NULL,
      longitude        DOUBLE    NOT NULL,
      acq_ts           TIMESTAMP NOT NULL,  -- UTC
      instrument       VARCHAR   NOT NULL,  -- MODIS | VIIRS (provenance only)
      satellite        VARCHAR   NOT NULL,  -- Terra | Aqua | SNPP | NOAA20 | NOAA21
      confidence_class VARCHAR   NOT NULL,  -- low | nominal | high (common scale)
      frp              DOUBLE,              -- fire radiative power, MW
      daynight         VARCHAR,
      cell_x           INTEGER   NOT NULL,  -- common grid index (longitude)
      cell_y           INTEGER   NOT NULL,  -- common grid index (latitude)
      ingested_at      TIMESTAMP NOT NULL,
      PRIMARY KEY (satellite, acq_ts, latitude, longitude)
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
