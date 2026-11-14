import { toSqlTimestamp, type Database, type Row, type SqlParams } from '../db/database.js';
import { HOTSPOT_COLUMN_NAMES } from '../db/schema.js';
import {
  CLUSTER_CELL_DEG,
  CONFIDENCE_CLASSES,
  DEFAULT_SCOPE,
  type BBox,
  type ConfidenceClass,
  type IngestScope,
  type Sensor,
} from './domain.js';

export interface HotspotFilter {
  bbox?: BBox | null;
  /** Acquisition time window (UTC). */
  from?: Date;
  to?: Date;
  /** Minimum confidence class to include. */
  minConfidence?: ConfidenceClass;
  /**
   * Keep only presumed vegetation fires (`type = 0`), as the ETL's harmonization does.
   * Live rows have no `type` (FIRMS NRT files do not carry it) and are always kept.
   */
  vegetationOnly?: boolean;
  /** Only live rows stored after this moment (exclusive): incremental map updates. */
  ingestedAfter?: Date;
  /** Only rows stored up to this moment (inclusive): pins a query to a cursor. */
  ingestedUntil?: Date;
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

/** FIRMS file family of each sensor, named as in the ETL (`source` column). */
const ETL_SOURCE: Record<Sensor, { source: string; sensor: 'MODIS' | 'VIIRS'; satellite: string }> = {
  MODIS: { source: 'modis', sensor: 'MODIS', satellite: 'Terra' },
  VIIRS_SNPP: { source: 'viirs-snpp', sensor: 'VIIRS', satellite: 'S-NPP' },
  VIIRS_NOAA20: { source: 'viirs-jpss1', sensor: 'VIIRS', satellite: 'NOAA-20' },
  VIIRS_NOAA21: { source: 'viirs-jpss2', sensor: 'VIIRS', satellite: 'NOAA-21' },
};

/**
 * Turns one FIRMS NRT CSV into rows of the ETL's normalized schema (etl/src/sql.ts, step 1):
 * same columns, types, satellite names and confidence classes. This is normalization only;
 * harmonization stays in the ETL. The NRT files differ from the archive in two ways:
 *  - no `type` column (vegetation / static source / ...) → `type` is NULL unless the file has it,
 *  - no country (one file covers a whole region) → `country` is NULL.
 */
function normalizeNrtSql(sensor: Sensor, columns: Set<string>): string {
  const { source, sensor: family } = ETL_SOURCE[sensor];
  const col = (name: string, fallback = 'NULL') => (columns.has(name) ? `"${name}"` : fallback);
  const btMir = family === 'MODIS' ? col('brightness') : col('bright_ti4');
  const btTir = family === 'MODIS' ? col('bright_t31') : col('bright_ti5');
  const hhmm = `lpad(trim(acq_time), 4, '0')`;

  return `
    SELECT
      TRY_CAST(latitude AS DOUBLE) AS latitude,
      TRY_CAST(longitude AS DOUBLE) AS longitude,
      TRY_CAST(acq_date AS DATE) AS acq_date,
      ${hhmm} AS acq_time,
      TRY_CAST(acq_date AS DATE) + to_minutes(
        (TRY_CAST(${hhmm}[1:2] AS INTEGER) * 60 + TRY_CAST(${hhmm}[3:4] AS INTEGER))::BIGINT
      ) AS acq_datetime,
      '${family}' AS sensor,
      CASE
        WHEN upper(trim(satellite)) IN ('TERRA', 'T') THEN 'Terra'
        WHEN upper(trim(satellite)) IN ('AQUA', 'A') THEN 'Aqua'
        WHEN upper(trim(satellite)) IN ('N', 'NPP', 'SNPP', 'S-NPP', 'SUOMI NPP') THEN 'S-NPP'
        WHEN upper(trim(satellite)) IN ('N20', 'NOAA-20', 'NOAA20', 'J1', 'JPSS-1', 'JPSS1') THEN 'NOAA-20'
        WHEN upper(trim(satellite)) IN ('N21', 'NOAA-21', 'NOAA21', 'J2', 'JPSS-2', 'JPSS2') THEN 'NOAA-21'
        WHEN '${source}' = 'viirs-snpp' THEN 'S-NPP'
        WHEN '${source}' = 'viirs-jpss1' THEN 'NOAA-20'
        WHEN '${source}' = 'viirs-jpss2' THEN 'NOAA-21'
        ELSE trim(satellite)
      END AS satellite,
      ${
        family === 'MODIS'
          ? `CASE WHEN TRY_CAST(confidence AS INTEGER) < 30 THEN 'low'
                  WHEN TRY_CAST(confidence AS INTEGER) <= 80 THEN 'nominal'
                  WHEN TRY_CAST(confidence AS INTEGER) > 80 THEN 'high' END`
          : `CASE lower(trim(confidence)) WHEN 'l' THEN 'low' WHEN 'low' THEN 'low'
                                          WHEN 'n' THEN 'nominal' WHEN 'nominal' THEN 'nominal'
                                          WHEN 'h' THEN 'high' WHEN 'high' THEN 'high' END`
      } AS confidence,
      trim(confidence) AS confidence_raw,
      TRY_CAST(frp AS DOUBLE) AS frp,
      TRY_CAST(${btMir} AS DOUBLE) AS bt_mir,
      TRY_CAST(${btTir} AS DOUBLE) AS bt_tir,
      TRY_CAST(scan AS DOUBLE) AS scan,
      TRY_CAST(track AS DOUBLE) AS track,
      round(TRY_CAST(scan AS DOUBLE) * TRY_CAST(track AS DOUBLE), 4) AS pixel_km2,
      upper(trim(daynight)) AS daynight,
      TRY_CAST(${col('type')} AS TINYINT) AS type,
      trim(version) AS version,
      '${source}' AS source,
      CAST(NULL AS VARCHAR) AS country,
      CAST(year(TRY_CAST(acq_date AS DATE)) AS INTEGER) AS year
    FROM read_csv($path, header = true, all_varchar = true, auto_detect = true)`;
}

export class HotspotRepository {
  constructor(private readonly db: Database) {}

  /** Loads a FIRMS NRT CSV into `live_hotspots`. Returns the number of new rows. */
  async ingestCsv(filePath: string, sensor: Sensor, bbox: BBox | null, now: Date): Promise<number> {
    const header = await this.db.all<{ column_name: string }>(
      `DESCRIBE SELECT * FROM read_csv($path, header = true, all_varchar = true, auto_detect = true)`,
      { path: filePath },
    );
    const columns = new Set(header.map((c) => c.column_name.toLowerCase()));
    const [west, south, east, north] = bbox ?? [null, null, null, null];
    return this.db.run(
      `INSERT OR IGNORE INTO live_hotspots
       SELECT ${HOTSPOT_COLUMN_NAMES.map((c) => `"${c}"`).join(', ')}, CAST($now AS TIMESTAMP)
       FROM (${normalizeNrtSql(sensor, columns)}) n
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND acq_datetime IS NOT NULL
         -- Days the archive already holds for this satellite come from the archive.
         AND NOT EXISTS (SELECT 1 FROM archive_coverage c WHERE c.satellite = n.satellite AND n.acq_date <= c.last_date)
         AND ($west IS NULL OR (longitude BETWEEN $west AND $east AND latitude BETWEEN $south AND $north))`,
      { path: filePath, now: toSqlTimestamp(now), west, south, east, north },
    );
  }

  /** Drops live rows the archive now covers, and rows past the retention limit. */
  purge(cutoff: Date): Promise<number> {
    return this.db.run(
      `DELETE FROM live_hotspots l
       WHERE acq_datetime < CAST($cutoff AS TIMESTAMP)
          OR EXISTS (SELECT 1 FROM archive_coverage c WHERE c.satellite = l.satellite AND l.acq_date <= c.last_date)`,
      { cutoff: toSqlTimestamp(cutoff) },
    );
  }

  find(filter: HotspotFilter, limit: number): Promise<Row[]> {
    const { where, params } = buildWhere(filter);
    return this.db.all(`${SELECT_PUBLIC} ${where} ORDER BY acq_datetime DESC LIMIT ${Math.trunc(limit)}`, params);
  }

  /** Streams every matching hotspot (for CSV export), chunk by chunk. */
  stream(filter: HotspotFilter): AsyncGenerator<Row[]> {
    const { where, params } = buildWhere(filter);
    return this.db.stream(`${SELECT_PUBLIC} ${where} ORDER BY acq_datetime`, params);
  }

  detections(filter: HotspotFilter): Promise<Detection[]> {
    const { where, params } = buildWhere(filter);
    return this.db.all<Detection>(
      `SELECT latitude AS lat, longitude AS lon, CAST(epoch_ms(acq_datetime) AS DOUBLE) AS t,
              coalesce(frp, 0) AS frp,
              CAST(floor(longitude / ${CLUSTER_CELL_DEG}) AS INTEGER) AS "cellX",
              CAST(floor(latitude / ${CLUSTER_CELL_DEG}) AS INTEGER) AS "cellY"
       FROM hotspots_all ${where}`,
      params,
    );
  }

  /**
   * Latest storage time of a live row, as an ISO string with milliseconds.
   * Clients pass it back as `since` to receive only rows stored afterwards.
   */
  async cursor(): Promise<string | null> {
    const [row] = await this.db.all(
      `SELECT strftime(max(ingested_at), '%Y-%m-%dT%H:%M:%S.%gZ') AS cursor FROM live_hotspots`,
    );
    return row?.cursor ?? null;
  }

  async stats(): Promise<Row> {
    const [row] = await this.db.all(
      `SELECT CAST(count(*) AS INTEGER) AS "liveHotspots",
              strftime(min(acq_datetime), '%Y-%m-%dT%H:%M:%SZ') AS "oldestAcquisition",
              strftime(max(acq_datetime), '%Y-%m-%dT%H:%M:%SZ') AS "latestAcquisition"
       FROM live_hotspots_visible`,
    );
    return row;
  }
}

export const PUBLIC_COLUMNS = [
  'latitude',
  'longitude',
  'acq_datetime',
  'sensor',
  'satellite',
  'confidence',
  'frp',
  'daynight',
  'type',
  'country',
  'origin',
] as const;

const SELECT_PUBLIC = `
  SELECT latitude, longitude, strftime(acq_datetime, '%Y-%m-%dT%H:%M:%SZ') AS acq_datetime,
         sensor, satellite, confidence, frp, daynight, type, country, origin
  FROM hotspots_all`;

/** WHERE clause over `hotspots_all`; also used by the report. */
export function buildWhere(filter: HotspotFilter): { where: string; params: SqlParams } {
  const conditions: string[] = [];
  const params: SqlParams = {};
  if (filter.bbox) {
    const [west, south, east, north] = filter.bbox;
    conditions.push('longitude BETWEEN $west AND $east AND latitude BETWEEN $south AND $north');
    Object.assign(params, { west, south, east, north });
  }
  if (filter.from) {
    conditions.push('acq_datetime >= CAST($from AS TIMESTAMP)');
    // Lets DuckDB skip whole year=YYYY partitions of the archive.
    conditions.push(`year >= ${filter.from.getUTCFullYear()}`);
    params.from = toSqlTimestamp(filter.from);
  }
  if (filter.to) {
    conditions.push('acq_datetime <= CAST($to AS TIMESTAMP)');
    conditions.push(`year <= ${filter.to.getUTCFullYear()}`);
    params.to = toSqlTimestamp(filter.to);
  }
  if (filter.vegetationOnly) conditions.push('coalesce(type, 0) = 0');
  if (filter.ingestedAfter) {
    conditions.push("origin = 'live' AND ingested_at > CAST($ingestedAfter AS TIMESTAMP)");
    params.ingestedAfter = toSqlTimestamp(filter.ingestedAfter);
  }
  if (filter.ingestedUntil) {
    conditions.push("(origin = 'archive' OR ingested_at <= CAST($ingestedUntil AS TIMESTAMP))");
    params.ingestedUntil = toSqlTimestamp(filter.ingestedUntil);
  }
  if (filter.minConfidence && filter.minConfidence !== 'low') {
    const allowed = CONFIDENCE_CLASSES.slice(CONFIDENCE_CLASSES.indexOf(filter.minConfidence));
    conditions.push(`confidence IN (${allowed.map((c) => `'${c}'`).join(', ')})`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

/** Persists the single active ingest scope and the history of ingest runs. */
export class IngestStateRepository {
  constructor(private readonly db: Database) {}

  async getScope(): Promise<IngestScope> {
    const [row] = await this.db.all('SELECT scope FROM live_scope WHERE id = 1');
    if (!row) return DEFAULT_SCOPE;
    // Unknown keys from older versions (e.g. pollIntervalMinutes) are dropped.
    const stored = JSON.parse(row.scope);
    const scope = { ...DEFAULT_SCOPE };
    for (const key of Object.keys(DEFAULT_SCOPE) as (keyof IngestScope)[]) {
      if (stored[key] !== undefined) (scope as any)[key] = stored[key];
    }
    return scope;
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
