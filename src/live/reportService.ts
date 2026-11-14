import { toSqlTimestamp, type Database, type SqlParams } from '../db/database.js';
import type { BBox } from './domain.js';
import type { ModeState } from './modeController.js';
import type { IngestStateRepository } from './repository.js';

export interface ReportQuery {
  /** Area chosen in the frontend; falls back to the ingest scope's bbox, then to everything stored. */
  bbox: BBox | null;
  hours: number;
  now?: Date;
}

/** Size of the coarse cells used to rank the most active areas, in degrees (~55 km). */
const AREA_CELL_DEG = 0.5;
const TOP_AREAS = 10;

/**
 * Summary of the live data for one area and time window, computed in DuckDB.
 * Activity is measured in active ~1 km grid cells (harmonized, sensor-independent);
 * raw detection counts are included for reference only.
 */
export class ReportService {
  constructor(
    private readonly db: Database,
    private readonly state: IngestStateRepository,
    private readonly mode: () => ModeState,
  ) {}

  async report(query: ReportQuery) {
    const now = query.now ?? new Date();
    const from = new Date(now.getTime() - query.hours * 3_600_000);
    const scope = await this.state.getScope();
    const bbox = query.bbox ?? scope.bbox;

    const params: SqlParams = { from: toSqlTimestamp(from), to: toSqlTimestamp(now) };
    let where = 'acq_ts BETWEEN CAST($from AS TIMESTAMP) AND CAST($to AS TIMESTAMP)';
    if (bbox) {
      where += ' AND longitude BETWEEN $west AND $east AND latitude BETWEEN $south AND $north';
      Object.assign(params, { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] });
    }

    const [totals] = await this.db.all(
      `SELECT CAST(count(*) AS INTEGER) AS detections,
              CAST(count(DISTINCT (cell_x, cell_y)) AS INTEGER) AS "activeCells",
              round(coalesce(sum(frp), 0), 1) AS "totalFrpMw",
              round(coalesce(max(frp), 0), 1) AS "maxFrpMw",
              strftime(min(acq_ts), '%Y-%m-%dT%H:%M:%SZ') AS "firstDetection",
              strftime(max(acq_ts), '%Y-%m-%dT%H:%M:%SZ') AS "lastDetection"
       FROM live_hotspots WHERE ${where}`,
      params,
    );

    const byConfidence = await this.db.all(
      `SELECT confidence_class AS confidence, CAST(count(*) AS INTEGER) AS detections
       FROM live_hotspots WHERE ${where} GROUP BY 1 ORDER BY 1`,
      params,
    );

    const bySatellite = await this.db.all(
      `SELECT instrument, satellite, CAST(count(*) AS INTEGER) AS detections
       FROM live_hotspots WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    );

    // Hourly series with empty hours filled in, ready for a chart.
    const timeline = await this.db.all(
      `WITH hours AS (
         SELECT unnest(generate_series(date_trunc('hour', CAST($from AS TIMESTAMP)),
                                       date_trunc('hour', CAST($to AS TIMESTAMP)),
                                       INTERVAL 1 HOUR)) AS hour
       ), activity AS (
         SELECT date_trunc('hour', acq_ts) AS hour,
                count(DISTINCT (cell_x, cell_y)) AS cells, count(*) AS detections
         FROM live_hotspots WHERE ${where} GROUP BY 1
       )
       SELECT strftime(hours.hour, '%Y-%m-%dT%H:00:00Z') AS hour,
              CAST(coalesce(cells, 0) AS INTEGER) AS "activeCells",
              CAST(coalesce(detections, 0) AS INTEGER) AS detections
       FROM hours LEFT JOIN activity USING (hour) ORDER BY hours.hour`,
      params,
    );

    const topAreas = await this.db.all(
      `SELECT round(avg(longitude), 3) AS lon, round(avg(latitude), 3) AS lat,
              CAST(count(DISTINCT (cell_x, cell_y)) AS INTEGER) AS "activeCells",
              CAST(count(*) AS INTEGER) AS detections,
              round(sum(coalesce(frp, 0)), 1) AS "totalFrpMw",
              strftime(max(acq_ts), '%Y-%m-%dT%H:%M:%SZ') AS "lastDetection"
       FROM live_hotspots WHERE ${where}
       GROUP BY floor(longitude / ${AREA_CELL_DEG}), floor(latitude / ${AREA_CELL_DEG})
       ORDER BY "activeCells" DESC, "totalFrpMw" DESC
       LIMIT ${TOP_AREAS}`,
      params,
    );

    return {
      generatedAt: now.toISOString(),
      area: { bbox, source: query.bbox ? 'request' : scope.bbox ? 'ingest-scope' : 'all' },
      window: { from: from.toISOString(), to: now.toISOString(), hours: query.hours },
      acquisition: { ...this.mode(), scope, lastRun: await this.state.lastRun() },
      totals,
      byConfidence,
      bySatellite,
      timeline,
      topAreas,
    };
  }
}
