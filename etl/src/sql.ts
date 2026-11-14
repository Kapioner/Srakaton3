// SQL for ETL step 1: raw FIRMS CSVs -> one common hotspot schema.
//
// Output columns (one row = one raw detection, nothing is dropped here;
// vegetation-fire filtering by `type` happens in aggregates/queries):
//   latitude, longitude        WGS84
//   acq_date, acq_time         as in FIRMS (UTC), acq_time = 'HHMM'
//   acq_datetime               TIMESTAMP (UTC)
//   sensor                     'MODIS' | 'VIIRS'
//   satellite                  'Terra' | 'Aqua' | 'S-NPP' | 'NOAA-20' | 'NOAA-21'
//   confidence                 'low' | 'nominal' | 'high' (common classes)
//   confidence_raw             original value (MODIS 0-100, VIIRS l/n/h)
//   frp                        fire radiative power [MW]
//   bt_mir, bt_tir             brightness temp. [K]: MODIS brightness/bright_t31, VIIRS bright_ti4/bright_ti5
//   scan, track, pixel_km2     pixel size along scan/track [km], pixel_km2 = scan * track
//   daynight                   'D' | 'N'
//   type                       0 vegetation fire, 1 volcano, 2 static land source, 3 offshore
//   version                    product collection/version (distinguishes NRT vs standard)
//   source                     FIRMS file family (modis, viirs-snpp, viirs-jpss1, viirs-jpss2)
//   year, country              partition keys (from the file name)

import type { RawFile } from './sources.ts';

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const fileList = (files: RawFile[]) => `[${files.map((f) => lit(f.path)).join(', ')}]`;

// Explicit columns: no type sniffing, header-only files are fine, and every year/country parses the same way.
const MODIS_COLUMNS = `{
  'latitude': 'DOUBLE', 'longitude': 'DOUBLE', 'brightness': 'DOUBLE', 'scan': 'DOUBLE', 'track': 'DOUBLE',
  'acq_date': 'DATE', 'acq_time': 'VARCHAR', 'satellite': 'VARCHAR', 'instrument': 'VARCHAR',
  'confidence': 'VARCHAR', 'version': 'VARCHAR', 'bright_t31': 'DOUBLE', 'frp': 'DOUBLE',
  'daynight': 'VARCHAR', 'type': 'TINYINT'
}`;
const VIIRS_COLUMNS = `{
  'latitude': 'DOUBLE', 'longitude': 'DOUBLE', 'bright_ti4': 'DOUBLE', 'scan': 'DOUBLE', 'track': 'DOUBLE',
  'acq_date': 'DATE', 'acq_time': 'VARCHAR', 'satellite': 'VARCHAR', 'instrument': 'VARCHAR',
  'confidence': 'VARCHAR', 'version': 'VARCHAR', 'bright_ti5': 'DOUBLE', 'frp': 'DOUBLE',
  'daynight': 'VARCHAR', 'type': 'TINYINT'
}`;

const readCsv = (files: RawFile[], columns: string) =>
  `read_csv(${fileList(files)}, header = true, columns = ${columns}, filename = true, auto_detect = false)`;

/** SELECT producing normalized rows for the given files (any mix of sources/countries of one year). */
export function normalizeSelect(files: RawFile[]): string {
  const modis = files.filter((f) => f.source === 'modis');
  const viirs = files.filter((f) => f.source !== 'modis');

  const parts: string[] = [];
  if (modis.length) {
    parts.push(`
      SELECT latitude, longitude, brightness AS bt_mir, bright_t31 AS bt_tir, scan, track,
             acq_date, acq_time, satellite, confidence, version, frp, daynight, type, filename
      FROM ${readCsv(modis, MODIS_COLUMNS)}`);
  }
  if (viirs.length) {
    parts.push(`
      SELECT latitude, longitude, bright_ti4 AS bt_mir, bright_ti5 AS bt_tir, scan, track,
             acq_date, acq_time, satellite, confidence, version, frp, daynight, type, filename
      FROM ${readCsv(viirs, VIIRS_COLUMNS)}`);
  }
  if (!parts.length) throw new Error('normalizeSelect: no files');

  return `
    WITH raw AS (${parts.join('\n      UNION ALL')}
    ),
    named AS (
      SELECT *,
        regexp_extract(filename, '([a-z0-9-]+)_(\\d{4})_([^/\\\\]+)\\.csv$', ['source', 'year', 'country']) AS f
      FROM raw
    )
    SELECT
      latitude,
      longitude,
      acq_date,
      lpad(trim(acq_time), 4, '0') AS acq_time,
      acq_date + to_minutes(
        (CAST(lpad(trim(acq_time), 4, '0')[1:2] AS INTEGER) * 60 + CAST(lpad(trim(acq_time), 4, '0')[3:4] AS INTEGER))::BIGINT
      ) AS acq_datetime,
      CASE WHEN f.source = 'modis' THEN 'MODIS' ELSE 'VIIRS' END AS sensor,
      CASE
        WHEN upper(trim(satellite)) IN ('TERRA', 'T') THEN 'Terra'
        WHEN upper(trim(satellite)) IN ('AQUA', 'A') THEN 'Aqua'
        WHEN upper(trim(satellite)) IN ('N', 'NPP', 'SNPP', 'S-NPP', 'SUOMI NPP') THEN 'S-NPP'
        WHEN upper(trim(satellite)) IN ('N20', 'NOAA-20', 'NOAA20', 'J1', 'JPSS-1', 'JPSS1') THEN 'NOAA-20'
        WHEN upper(trim(satellite)) IN ('N21', 'NOAA-21', 'NOAA21', 'J2', 'JPSS-2', 'JPSS2') THEN 'NOAA-21'
        WHEN f.source = 'viirs-snpp' THEN 'S-NPP'
        WHEN f.source = 'viirs-jpss1' THEN 'NOAA-20'
        WHEN f.source = 'viirs-jpss2' THEN 'NOAA-21'
        ELSE trim(satellite)
      END AS satellite,
      CASE
        WHEN f.source = 'modis' THEN
          CASE WHEN TRY_CAST(confidence AS INTEGER) < 30 THEN 'low'
               WHEN TRY_CAST(confidence AS INTEGER) <= 80 THEN 'nominal'
               WHEN TRY_CAST(confidence AS INTEGER) > 80 THEN 'high' END
        ELSE
          CASE lower(trim(confidence)) WHEN 'l' THEN 'low' WHEN 'low' THEN 'low'
                                       WHEN 'n' THEN 'nominal' WHEN 'nominal' THEN 'nominal'
                                       WHEN 'h' THEN 'high' WHEN 'high' THEN 'high' END
      END AS confidence,
      trim(confidence) AS confidence_raw,
      frp,
      bt_mir,
      bt_tir,
      scan,
      track,
      round(scan * track, 4) AS pixel_km2,
      upper(trim(daynight)) AS daynight,
      type,
      trim(version) AS version,
      f.source AS source,
      CAST(f.year AS INTEGER) AS year,
      f.country AS country
    FROM named`;
}

/** Writes normalized rows into a hive-partitioned Parquet tree (year=/country=), sorted for good pruning. */
export function copyToParquet(files: RawFile[], targetDir: string): string {
  return `
    COPY (
      SELECT * FROM (${normalizeSelect(files)})
      ORDER BY country, acq_date, latitude, longitude
    ) TO ${lit(targetDir.replaceAll('\\', '/'))} (
      FORMAT parquet,
      COMPRESSION zstd,
      PARTITION_BY (year, country),
      FILENAME_PATTERN 'part_{i}',
      ROW_GROUP_SIZE 122880
    )`;
}

/** Row counts straight from the CSVs, used to validate that nothing was lost. */
export function rawCountSelect(files: RawFile[]): string {
  const modis = files.filter((f) => f.source === 'modis');
  const viirs = files.filter((f) => f.source !== 'modis');
  const parts: string[] = [];
  if (modis.length) parts.push(`SELECT count(*) AS n FROM ${readCsv(modis, MODIS_COLUMNS)}`);
  if (viirs.length) parts.push(`SELECT count(*) AS n FROM ${readCsv(viirs, VIIRS_COLUMNS)}`);
  return `SELECT sum(n)::BIGINT AS n FROM (${parts.join(' UNION ALL ')})`;
}

export { lit };
