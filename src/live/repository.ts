import { toSqlTimestamp, type Database, type Row, type SqlParams } from '../db/database.js';
import {
  CELL_SIZE_DEG,
  CONFIDENCE_CLASSES,
  DEFAULT_SCOPE,
  type BBox,
  type ConfidenceClass,
  type IngestScope,
  type Sensor,
} from './domain.js';

export interface HotspotFilter {
  bbox?: BBox | null;
  from?: Date;
  to?: Date;
  /** Minimum confidence class to include. */
  minConfidence?: ConfidenceClass;
}

/** A detection reduced to what the situation/forecast engine needs. */
export interface Detection {
  lat: number;
  lon: number;
  /** Epoch milliseconds (UTC). */
  t: number;
  frp: number;
  cellX: number;
  cellY: number;
}

export interface IngestRun {
  startedAt: string;
  finishedAt: string;
  status: 'ok' | 'partial' | 'failed';
  inserted: number;
  details: unknown;
}

const INSTRUMENT: Record<Sensor, { instrument: string; satellite: string }> = {
  MODIS: { instrument: 'MODIS', satellite: 'Terra' },
  VIIRS_SNPP: { instrument: 'VIIRS', satellite: 'SNPP' },
  VIIRS_NOAA20: { instrument: 'VIIRS', satellite: 'NOAA20' },
  VIIRS_NOAA21: { instrument: 'VIIRS', satellite: 'NOAA21' },
};

/**
 * Harmonization happens here, in one SQL statement shared by every sensor:
 *  - confidence → common low/nominal/high (MODIS 0–100: <30 low, 30–80 nominal, >80 high; VIIRS l/n/h),
 *  - satellite codes → canonical names,
 *  - acquisition date + time → one UTC timestamp,
 *  - position → index of the common grid cell.
 * NRT files carry no `type` column, so static (industrial) sources cannot be filtered at this stage.
 */
const HARMONIZE_AND_INSERT = `
  INSERT OR IGNORE INTO live_hotspots
  SELECT latitude, longitude, acq_ts, $instrument, satellite, confidence_class, frp, daynight,
         CAST(floor(longitude / ${CELL_SIZE_DEG}) AS INTEGER),
         CAST(floor(latitude  / ${CELL_SIZE_DEG}) AS INTEGER),
         CAST($now AS TIMESTAMP)
  FROM (
    SELECT
      TRY_CAST(latitude  AS DOUBLE) AS latitude,
      TRY_CAST(longitude AS DOUBLE) AS longitude,
      try_strptime(acq_date || ' ' || lpad(replace(acq_time, ':', ''), 4, '0'), '%Y-%m-%d %H%M') AS acq_ts,
      CASE upper(trim(satellite))
        WHEN 'T' THEN 'Terra' WHEN 'TERRA' THEN 'Terra'
        WHEN 'A' THEN 'Aqua'  WHEN 'AQUA'  THEN 'Aqua'
        WHEN 'N' THEN 'SNPP'  WHEN 'N20'   THEN 'NOAA20' WHEN 'N21' THEN 'NOAA21'
        ELSE $defaultSatellite
      END AS satellite,
      CASE
        WHEN TRY_CAST(confidence AS DOUBLE) IS NOT NULL THEN
          CASE WHEN CAST(confidence AS DOUBLE) < 30 THEN 'low'
               WHEN CAST(confidence AS DOUBLE) <= 80 THEN 'nominal'
               ELSE 'high' END
        ELSE CASE lower(left(trim(confidence), 1))
               WHEN 'l' THEN 'low' WHEN 'h' THEN 'high' ELSE 'nominal' END
      END AS confidence_class,
      TRY_CAST(frp AS DOUBLE) AS frp,
      upper(left(trim(daynight), 1)) AS daynight
    FROM read_csv($path, header = true, all_varchar = true)
  )
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND acq_ts IS NOT NULL
    AND ($west IS NULL OR (longitude BETWEEN $west AND $east AND latitude BETWEEN $south AND $north))`;

export class HotspotRepository {
  constructor(private readonly db: Database) {}

  /** Loads a FIRMS CSV into the harmonized table. Returns the number of new rows. */
  ingestCsv(filePath: string, sensor: Sensor, bbox: BBox | null, now: Date): Promise<number> {
    const [west, south, east, north] = bbox ?? [null, null, null, null];
    return this.db.run(HARMONIZE_AND_INSERT, {
      path: filePath,
      instrument: INSTRUMENT[sensor].instrument,
      defaultSatellite: INSTRUMENT[sensor].satellite,
      now: toSqlTimestamp(now),
      west,
      south,
      east,
      north,
    });
  }

  purgeOlderThan(cutoff: Date): Promise<number> {
    return this.db.run('DELETE FROM live_hotspots WHERE acq_ts < CAST($cutoff AS TIMESTAMP)', {
      cutoff: toSqlTimestamp(cutoff),
    });
  }

  find(filter: HotspotFilter, limit: number): Promise<Row[]> {
    const { where, params } = buildWhere(filter);
    return this.db.all(`${SELECT_PUBLIC} ${where} ORDER BY acq_ts DESC LIMIT ${Math.trunc(limit)}`, params);
  }

  /** Streams every matching hotspot (for CSV export), chunk by chunk. */
  stream(filter: HotspotFilter): AsyncGenerator<Row[]> {
    const { where, params } = buildWhere(filter);
    return this.db.stream(`${SELECT_PUBLIC} ${where} ORDER BY acq_ts`, params);
  }

  detections(filter: HotspotFilter): Promise<Detection[]> {
    const { where, params } = buildWhere(filter);
    return this.db.all<Detection>(
      `SELECT latitude AS lat, longitude AS lon, CAST(epoch_ms(acq_ts) AS DOUBLE) AS t,
              coalesce(frp, 0) AS frp, cell_x AS "cellX", cell_y AS "cellY"
       FROM live_hotspots ${where}`,
      params,
    );
  }

  async stats(): Promise<Row> {
    const [row] = await this.db.all(
      `SELECT CAST(count(*) AS INTEGER) AS hotspots,
              strftime(min(acq_ts), '%Y-%m-%dT%H:%M:%SZ') AS "oldestAcquisition",
              strftime(max(acq_ts), '%Y-%m-%dT%H:%M:%SZ') AS "latestAcquisition"
       FROM live_hotspots`,
    );
    return row;
  }
}

export const PUBLIC_COLUMNS = [
  'latitude',
  'longitude',
  'acq_datetime',
  'instrument',
  'satellite',
  'confidence',
  'frp',
  'daynight',
] as const;

const SELECT_PUBLIC = `
  SELECT latitude, longitude, strftime(acq_ts, '%Y-%m-%dT%H:%M:%SZ') AS acq_datetime,
         instrument, satellite, confidence_class AS confidence, frp, daynight
  FROM live_hotspots`;

function buildWhere(filter: HotspotFilter): { where: string; params: SqlParams } {
  const conditions: string[] = [];
  const params: SqlParams = {};
  if (filter.bbox) {
    const [west, south, east, north] = filter.bbox;
    conditions.push('longitude BETWEEN $west AND $east AND latitude BETWEEN $south AND $north');
    Object.assign(params, { west, south, east, north });
  }
  if (filter.from) {
    conditions.push('acq_ts >= CAST($from AS TIMESTAMP)');
    params.from = toSqlTimestamp(filter.from);
  }
  if (filter.to) {
    conditions.push('acq_ts <= CAST($to AS TIMESTAMP)');
    params.to = toSqlTimestamp(filter.to);
  }
  if (filter.minConfidence && filter.minConfidence !== 'low') {
    const allowed = CONFIDENCE_CLASSES.slice(CONFIDENCE_CLASSES.indexOf(filter.minConfidence));
    conditions.push(`confidence_class IN (${allowed.map((c) => `'${c}'`).join(', ')})`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** Persists the single active ingest scope and the history of ingest runs. */
export class IngestStateRepository {
  constructor(private readonly db: Database) {}

  async getScope(): Promise<IngestScope> {
    const [row] = await this.db.all('SELECT scope FROM live_scope WHERE id = 1');
    return row ? { ...DEFAULT_SCOPE, ...JSON.parse(row.scope) } : DEFAULT_SCOPE;
  }

  async saveScope(scope: IngestScope, now: Date): Promise<void> {
    await this.db.run('INSERT OR REPLACE INTO live_scope VALUES (1, $scope, CAST($now AS TIMESTAMP))', {
      scope: JSON.stringify(scope),
      now: toSqlTimestamp(now),
    });
  }

  async recordRun(run: IngestRun): Promise<void> {
    await this.db.run(
      `INSERT INTO live_ingest_runs
       VALUES (CAST($startedAt AS TIMESTAMP), CAST($finishedAt AS TIMESTAMP), $status, $inserted, $details)`,
      {
        startedAt: run.startedAt.replace('T', ' ').replace('Z', ''),
        finishedAt: run.finishedAt.replace('T', ' ').replace('Z', ''),
        status: run.status,
        inserted: run.inserted,
        details: JSON.stringify(run.details),
      },
    );
  }

  async lastRun(): Promise<IngestRun | null> {
    const [row] = await this.db.all(
      `SELECT strftime(started_at, '%Y-%m-%dT%H:%M:%SZ') AS "startedAt",
              strftime(finished_at, '%Y-%m-%dT%H:%M:%SZ') AS "finishedAt",
              status, inserted, details
       FROM live_ingest_runs ORDER BY started_at DESC LIMIT 1`,
    );
    return row ? ({ ...row, details: JSON.parse(row.details) } as IngestRun) : null;
  }
}
