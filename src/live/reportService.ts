import { toSqlTimestamp, type Database } from '../db/database.js';
import type { EtlParams } from '../etl.js';
import type { BBox } from './domain.js';
import type { ModeState } from './modeController.js';
import { buildWhere, type IngestStateRepository } from './repository.js';

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
 * Summary of the current picture for one area and time window, read from `hotspots_all`
 * (ETL archive + live, vegetation fires only). Counts are not harmonized: `detections` are raw,
 * `fireCells` are distinct cells of the ETL's fine grid with at least one detection.
 * The harmonized, sensor-independent series is the ETL's `harmonized/` dataset.
 */
export class ReportService {
  constructor(
    private readonly db: Database,
    private readonly state: IngestStateRepository,
    private readonly mode: () => ModeState,
    /** The ETL owns the method; the report only reuses its fine grid so "fire cells" mean the same thing. */
    private readonly etl: EtlParams,
  ) {}

  async report(query: ReportQuery) {
    const now = query.now ?? new Date();
    const from = new Date(now.getTime() - query.hours * 3_600_000);
    const scope = await this.state.getScope();
    const bbox = query.bbox ?? scope.bbox;
    const { where, params } = buildWhere({ bbox, from, to: now, vegetationOnly: true });
    const size = this.etl.fineGridDeg;
    const cell = `(floor(latitude / ${size}), floor(longitude / ${size}))`;

    const [totals] = await this.db.all(
      `SELECT CAST(count(*) AS INTEGER) AS detections,
              CAST(count(DISTINCT ${cell}) AS INTEGER) AS "fireCells",
              round(coalesce(sum(frp), 0), 1) AS "totalFrpMw",
              round(coalesce(max(frp), 0), 1) AS "maxFrpMw",
              strftime(min(acq_datetime), '%Y-%m-%dT%H:%M:%SZ') AS "firstDetection",
              strftime(max(acq_datetime), '%Y-%m-%dT%H:%M:%SZ') AS "lastDetection"
       FROM hotspots_all ${where}`,
      params,
    );

    const byConfidence = await this.db.all(
      `SELECT confidence, CAST(count(*) AS INTEGER) AS detections
       FROM hotspots_all ${where} GROUP BY 1 ORDER BY 1`,
      params,
    );

    const bySatellite = await this.db.all(
      `SELECT sensor, satellite, CAST(count(*) AS INTEGER) AS detections
       FROM hotspots_all ${where} GROUP BY 1, 2 ORDER BY 1, 2`,
      params,
    );

    const byOrigin = await this.db.all(
      `SELECT origin, CAST(count(*) AS INTEGER) AS detections
       FROM hotspots_all ${where} GROUP BY 1 ORDER BY 1`,
      params,
    );

    // Hourly series with empty hours filled in, ready for a chart.
    const timeline = await this.db.all(
      `WITH hours AS (
         SELECT unnest(generate_series(date_trunc('hour', CAST($hFrom AS TIMESTAMP)),
                                       date_trunc('hour', CAST($hTo AS TIMESTAMP)),
                                       INTERVAL 1 HOUR)) AS hour
       ), activity AS (
         SELECT date_trunc('hour', acq_datetime) AS hour,
                count(DISTINCT ${cell}) AS cells, count(*) AS detections
         FROM hotspots_all ${where} GROUP BY 1
       )
       SELECT strftime(hours.hour, '%Y-%m-%dT%H:00:00Z') AS hour,
              CAST(coalesce(cells, 0) AS INTEGER) AS "fireCells",
              CAST(coalesce(detections, 0) AS INTEGER) AS detections
       FROM hours LEFT JOIN activity USING (hour) ORDER BY hours.hour`,
      { ...params, hFrom: toSqlTimestamp(from), hTo: toSqlTimestamp(now) },
    );

    const topAreas = await this.db.all(
      `SELECT round(avg(longitude), 3) AS lon, round(avg(latitude), 3) AS lat,
              CAST(count(DISTINCT ${cell}) AS INTEGER) AS "fireCells",
              CAST(count(*) AS INTEGER) AS detections,
              round(sum(coalesce(frp, 0)), 1) AS "totalFrpMw",
              strftime(max(acq_datetime), '%Y-%m-%dT%H:%M:%SZ') AS "lastDetection"
       FROM hotspots_all ${where}
       GROUP BY floor(longitude / ${AREA_CELL_DEG}), floor(latitude / ${AREA_CELL_DEG})
       ORDER BY "fireCells" DESC, "totalFrpMw" DESC
       LIMIT ${TOP_AREAS}`,
      params,
    );

    return {
      generatedAt: now.toISOString(),
      area: { bbox, source: query.bbox ? 'request' : scope.bbox ? 'ingest-scope' : 'all' },
      window: { from: from.toISOString(), to: now.toISOString(), hours: query.hours },
      units: { fireCellDeg: size, harmonized: false, gridFrom: this.etl.source },
      acquisition: { ...this.mode(), scope, lastRun: await this.state.lastRun() },
      totals,
      byConfidence,
      bySatellite,
      byOrigin,
      timeline,
      topAreas,
    };
  }
}
